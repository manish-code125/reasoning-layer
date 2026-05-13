# Reasoning Layer — Implementation Phases

This document tracks the phased implementation plan for integrating Stoa reasoning discipline
into the Reasoning Layer pipeline.

All decision data lives in **Postgres** — no markdown WAL files. Context logs and exports are
derived views generated from the database on demand.

---

## Phase 1 — WAL Upgrade ✅ Shipped

**Goal:** Promote the `Decision` model to a proper append-only WAL entry. Foundation for all subsequent phases.

### What shipped

| Change | Detail |
|---|---|
| `reasoningArc String?` on `Decision` | Captures the dialogue/context that led to the entry — richer than Q+A alone |
| `sessionId String?` on `Decision` | FK placeholder for Phase 2 `RefiningSession`; present in schema so Phase 2 needs no migration |
| Rollback validation — all write paths | `supersedes_id` must reference a valid existing decision. Previously missing from the Slack modal submit handler; now enforced everywhere |
| `reasoning_arc` in all API responses | Included in `GET /decisions`, `GET /decisions/:id`, `GET /decisions/export`, `GET /decisions/export-since` |
| Migration `20260512000001_wal_upgrade` | `ALTER TABLE decisions ADD COLUMN reasoning_arc TEXT; ADD COLUMN session_id TEXT` |

### Fast path (backwards compatible)

The existing Q→A flow is unchanged. Routing a question and getting a single Slack reply still
creates a WAL entry immediately — `reasoning_arc` is `null` for fast-path entries. Phase 2
sessions will populate it.

---

## Phase 2 — Async Refining Session

**Goal:** Questions are fire-and-forget from the developer's perspective. Routing a question
does not block the developer — they state an interim assumption and proceed immediately.
Answers land asynchronously into the WAL and are surfaced at the next natural checkpoint,
mirroring how Stoa's async ask pattern works.

### Core mental model

| Phase 1 fast path | Phase 2 async |
|---|---|
| Route question → wait → DM → resume | Route question → **state assumption → proceed** |
| Answer is a gate | Answer is an event that drifts in later |
| Developer blocked | Developer always moving |

### New schema

```prisma
model RefiningSession {
  id                String           @id @default(uuid())
  promptId          String
  prompt            Prompt           @relation(fields: [promptId], references: [id])
  questionId        String?          @unique
  question          Question?        @relation(fields: [questionId], references: [id])
  topic             String           // short label for the topic being refined
  // open | settled | tabled | abandoned
  status            String           @default("open")
  // decision | wont_do | table | branch | rollback | observation
  outcome           String?
  // ID of the interim table WAL entry written when question was routed — superseded on settlement
  interimDecisionId String?
  createdAt         DateTime         @default(now())
  settledAt         DateTime?
  messages          SessionMessage[]
  decisions         Decision[]

  @@map("refining_sessions")
}

model SessionMessage {
  id        String           @id @default(uuid())
  sessionId String
  session   RefiningSession  @relation(fields: [sessionId], references: [id])
  // developer | reviewer | ai
  role      String
  content   String
  slackTs   String?          // Slack message ts if this turn came via Slack
  createdAt DateTime         @default(now())

  @@map("session_messages")
}
```

### Question statuses

| Status | Meaning |
|---|---|
| `pending` | Generated, not yet answered or routed |
| `answered_locally` | Developer answered inline; WAL entry written immediately |
| `routed` | Sent to Slack; interim `table` WAL entry written; developer proceeds |
| `resolved` | Slack answer landed; final `decision` WAL entry written |

### New API endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/sessions` | Start a refining session for a question or open topic |
| `GET` | `/api/sessions/:id` | Full session state + message history |
| `POST` | `/api/sessions/:id/messages` | Add a dialogue turn (developer, reviewer, or AI) |
| `POST` | `/api/sessions/:id/settle` | Settle → writes final `decision` WAL entry; sets `supersedes_id` → interim `table` entry; `reasoning_arc` assembled from full message history |
| `POST` | `/api/sessions/:id/branch` | Decompose → creates N child sessions; parent marked `branched` |
| `POST` | `/api/sessions/:id/table` | Defer → creates a `table` WAL entry; session marked `tabled` |
| `POST` | `/api/sessions/:id/abandon` | Explicitly close without a WAL entry |
| `GET` | `/api/sessions/catch-up` | `?repo=<path>&since=<iso>` — returns decisions that landed + questions still in-flight since a timestamp |

### Routing flow (async)

When `POST /api/questions/:id/route` is called:

1. Question is posted to the Slack thread as before
2. A `RefiningSession` is opened with `status: "open"`
3. **An interim `table` WAL entry is written immediately** capturing the developer's working assumption:
   ```
   ## <hex-id> — table — <date>
   In-flight: <question text>
   Proceeding with assumption: <assumption text supplied by developer>
   Routing to: @reviewer via Slack
   Triggers to revisit: Slack answer lands
   ```
4. The developer proceeds — no DM, no waiting

### Settlement flow (async, reviewer-driven)

When a Slack answer lands (plain reply prefixed with `/settle`, `/table`, or `/wont-do`, or via the Settle button):

1. Backend writes the final WAL entry (`decision`, `wont_do`, etc.)
2. If an interim `table` entry exists for the question, the new entry sets `supersedes_id` → that entry — the assumption is now resolved
3. `reasoning_arc` is assembled from the full `SessionMessage` history
4. A Slack DM is sent to the developer as **FYI only**: *"Decision landed: [summary]. Your next session will pick this up."*
5. No developer action required to "resume"

### Catch-up cadence (session start)

Before Step 1 (submit task) of the pipeline, the agent calls `GET /api/sessions/catch-up`.
Response surfaces:

- **Decisions that landed** since the last session timestamp (resolved interim `table` entries)
- **Still in-flight** questions (routed, not yet answered)

Claude surfaces these before the developer describes the new task:

> "Since your last session: 2 decisions landed — [summary]. 1 question is still in-flight with @reviewer — proceeding with the prior assumption."

### Enrichment upgrade

`GET /api/prompts/:id/enriched` gains a second pass:

- Past decisions (existing semantic search) — treated as hard constraints
- In-flight questions with their interim assumptions — flagged explicitly so Claude knows where the working assumptions live

### Fast path preserved

A Slack reply that starts with `/settle` on the very first reply still settles immediately —
a session is opened and immediately closed. Backwards compatible; no API changes for existing callers.

### Agent file additions (`.claude/reasoning-layer.md` v1.3.0)

```python
# Catch-up cadence — runs before Step 1:
GET /api/sessions/catch-up?repo=<path>&since=<last_session_ts>

# After routing — Claude can participate in multi-turn sessions:
POST /sessions/:id/messages  { "role": "ai", "content": "..." }

# When session is ready to settle (reviewer-driven, not developer-driven):
POST /sessions/:id/settle    {
  "outcome": "decision",
  "answer": "...",
  "rationale": "...",
  "reasoning_arc": "Assembled summary of the dialogue arc"
}
```

---

## Phase 3 — Artifact Coherence ✅ Shipped

**Goal:** Track which files in a repo are governed by which decisions. Surface drift when code
moves ahead of the WAL. Optionally block commits to tracked files without a corresponding WAL entry.

### What shipped

| Change | Detail |
|---|---|
| `TrackedArtifact` + `ArtifactDecisionLink` schema | Files linked to decisions via junction table |
| `GET/POST/DELETE /api/repos/:id/artifacts` | Track, list, and untrack files |
| `POST /api/repos/:id/artifacts/drift` | Drift detection — client passes file timestamps |
| `POST /api/artifacts/drift` | Convenience endpoint — repo path in body (used by pre-commit hook) |
| `POST/DELETE /api/decisions/:id/link-artifacts` | Link/unlink decisions to file paths; auto-tracks if not yet tracked |
| Enrichment Pass 2 | Linked decisions injected as hard constraints in `GET /prompts/:id/enriched` |
| Superseded decision flag fix | Now correctly detects when a constraint has been superseded by a newer rollback entry |
| `scripts/pre-commit` | Python3 hook — warn or block commits when staged files have unresolved drift |
| `scripts/install-coherence-hook.sh` | One-command installer: copies hook + wires `git config core.hooksPath` |
| Agent file v1.4.0 | Step 3b: after recording decisions, suggests linking them to tracked files |

### What it solves

Without this phase, decisions and code are disconnected — a decision is made in Slack, stored
in Postgres, but nothing checks whether the relevant source files were actually updated to
reflect it. Stoa calls this the design↔code loop. Phase 3 closes it.

### New schema

```prisma
model TrackedArtifact {
  id          String                 @id @default(uuid())
  repoId      String
  repo        Repo                   @relation(fields: [repoId], references: [id])
  filePath    String                 // relative path within the repo
  description String?                // role this file plays (e.g. "canonical DB schema")
  createdAt   DateTime               @default(now())
  links       ArtifactDecisionLink[]

  @@unique([repoId, filePath])
  @@map("tracked_artifacts")
}

model ArtifactDecisionLink {
  artifactId  String
  artifact    TrackedArtifact @relation(fields: [artifactId], references: [id])
  decisionId  String
  decision    Decision        @relation(fields: [decisionId], references: [id])

  @@id([artifactId, decisionId])
  @@map("artifact_decision_links")
}
```

### New API endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/repos/:id/artifacts` | Track a file — body: `{ file_path, description? }` |
| `DELETE` | `/api/repos/:id/artifacts/:artifactId` | Untrack a file |
| `GET` | `/api/repos/:id/artifacts` | List tracked files + their linked decisions |
| `GET` | `/api/repos/:id/artifacts/drift` | Files whose linked decisions are newer than the file's last git commit timestamp |
| `POST` | `/api/decisions/:id/link-artifacts` | Link a decision to one or more file paths — body: `{ file_paths: string[] }` |
| `DELETE` | `/api/decisions/:id/link-artifacts` | Unlink a decision from file paths |

### Drift detection logic

`GET /api/repos/:id/artifacts/drift` works as follows:

1. Fetch all `TrackedArtifact` rows for the repo
2. For each artifact, fetch its linked decisions sorted by `createdAt desc`
3. Compare the most recent linked decision's `createdAt` against the file's last git commit
   timestamp (passed by the client as `?file_timestamps=<json>` or polled via the VS Code
   extension which has filesystem access)
4. Return artifacts where `latest_decision.createdAt > file_last_committed_at`

Response shape:
```json
{
  "drifted": [
    {
      "file_path": "packages/backend/prisma/schema.prisma",
      "description": "canonical DB schema",
      "latest_decision": {
        "hex_id": "a3f2e71",
        "entry_type": "decision",
        "question_text": "Should we add soft-delete to the users table?",
        "answer": "Yes — add deletedAt nullable timestamp",
        "created_at": "2026-05-12T10:00:00Z"
      },
      "file_last_committed_at": "2026-05-10T08:00:00Z"
    }
  ]
}
```

### VS Code command: `Reasoning Layer: Init Artifacts`

Equivalent of `/stoa init`. Runs a guided scan of the workspace:

1. Reads the workspace file tree, excluding `node_modules/`, `.git/`, `dist/`, build artifacts,
   and auto-generated files (detected by header markers)
2. Asks the developer: **All / None / Interactive** (default: Interactive)
3. In Interactive mode, proposes each candidate file one at a time — developer accepts or
   declines, optionally editing the role description
4. Accepted files are written to `POST /api/repos/:id/artifacts`
5. A summary is shown: N files tracked, M declined

### VS Code command: `Reasoning Layer: Track File`

Single-file tracking — equivalent of `/stoa track <path>`. Tracks the currently open file
with an optional description prompt.

### Enrichment upgrade

`GET /api/prompts/:id/enriched` gains a second pass on top of semantic search:

- For the task's repo, fetch all `TrackedArtifact` rows
- If any file in the task's `openFilePath` or the task content matches a tracked artifact,
  prepend its linked decisions as **hard constraints** at the top of the enriched prompt
- If any linked decision has been superseded (has a `rollback` entry pointing to it), flag
  it explicitly: *"⚠ Decision `a3f2e71` has been superseded by `b9c1d3e` — use the newer
  entry as the constraint"*

### Pre-commit hook generation

New VS Code command: `Reasoning Layer: Generate Coherence Hook`

Writes `.githooks/pre-commit` to the workspace root. On `git commit`:

1. Reads the list of staged files
2. Calls `GET /api/repos/:id/artifacts/drift` with the staged file paths
3. If any staged file is a tracked artifact with drift:
   - **Warn mode** (default): prints the relevant decisions and continues the commit
   - **Block mode** (opt-in via `reasoning-layer.hookMode: "block"`): exits non-zero,
     blocking the commit until the developer acknowledges or creates a new WAL entry

Wired via `git config core.hooksPath .githooks` — same pattern as Stoa.

Hook behaviour is configurable in VS Code settings:
```json
{
  "reasoning-layer.hookMode": "warn"   // "warn" | "block"
}
```

### Hook installation — current state vs. target state

| State | How the hook gets installed |
|---|---|
| **Now (bridge)** | Developer runs `bash scripts/install-coherence-hook.sh` once per repo |
| **Extension Phase 1 (target)** | Extension `activate()` detects the workspace git root, writes `.githooks/pre-commit`, and runs `git config core.hooksPath .githooks` silently on first activation — zero extra steps |

The `scripts/pre-commit` file and `scripts/install-coherence-hook.sh` are temporary. When the extension ships, the hook is bundled inside the `.vsix` and installed automatically. The shell scripts can be removed at that point.

---

## Phase 4 — Agent File Coherence Cadences ✅ Shipped

**Goal:** Add two Stoa-style coherence cadences to the Claude Code agent file
(`.claude/reasoning-layer.md`) so drift is surfaced proactively without developer action.

### What shipped

| Change | Detail |
|---|---|
| `GET /api/decisions/:id/linked-artifacts` | Returns tracked artifacts linked to a specific decision — used by Cadence B |
| Agent file v1.5.0 — Step 0b (Cadence A) | Pre-task drift check: fetches all tracked artifacts, gets git timestamps, calls drift endpoint, surfaces stale decisions before task starts |
| Agent file v1.5.0 — Step 3c (Cadence B) | Post-decision propagation pass: after recording each decision, checks linked files and asks developer to update them in the same session |

### Cadence A — Pre-task drift check (Step 0b)

Runs **between Step 0 and Step 1** — before the task is even described.

1. Fetches all tracked artifacts for the repo (`GET /api/repos/:id/artifacts`)
2. Gets last git commit timestamp for each via `git log`
3. Calls `POST /api/artifacts/drift` with the timestamp map
4. If any files are drifted, surfaces the linked decisions as hard constraints and asks:
   *"Before we start — these decisions may not be reflected in the code yet. Address drift first?"*

Developer answers yes → Claude factors in the constraints before the task.
Developer answers no → proceeds, drift recorded, pre-commit hook is the backstop.

### Cadence B — Post-decision propagation pass (Step 3c)

Runs **after Step 3** for each recorded decision.

1. Calls `GET /api/decisions/:id/linked-artifacts`
2. If tracked files are linked, surfaces them and asks:
   *"Decision `a3f2e71` is linked to these files — should I update them now?"*
3. If developer confirms, Claude makes the code changes immediately in the same session
4. The pre-commit hook verifies drift is cleared when they commit

This closes the decision→code loop in the same session rather than leaving it to chance.

### Drift window — before and after

| | When drift is caught |
|---|---|
| Phase 3 only | At `git commit` (hours or days later) |
| Phase 4 Cadence A added | At session start (before the task) |
| Phase 4 Cadence B added | Immediately after the decision, same session |

---

## Phase 5 — Context Log Export ✅ Shipped

**Goal:** Generate Stoa-compatible markdown from Postgres on demand. The database is the
source of truth; the markdown is a derived view.

### New API endpoint

`GET /api/repos/:id/context-log`

Renders the full WAL for a repo as Stoa-formatted markdown:

```markdown
## a3f2e71 — decision — 2026-05-12

**Question:** Should we add soft-delete to the users table?

**Decision:** Yes — add `deletedAt` nullable timestamp. Hard-delete remains available
for GDPR erasure requests only.

**Rationale:** Soft-delete gives us recoverability for accidental deletes without
complicating the data model. GDPR erasure is a rare, deliberate operation.

**Alternatives considered:** Hard-delete only (rejected — no recovery path);
event sourcing (rejected — over-engineered for this use case).

**Decided by:** @reviewer

---

## b9c1d3e — rollback — 2026-05-14

**Supersedes:** a3f2e71

**Decision:** Revert soft-delete — add a separate `deleted_users` archive table instead.

**Rationale:** Soft-delete required adding `WHERE deletedAt IS NULL` to every query.
The archive table approach keeps the main table clean.

---
```

Accepts query params:
- `?since=<iso>` — entries after a date
- `?type=<entry_type>` — filter by type
- `?format=stoa` (default) or `?format=adr`

### What shipped

| Change | Detail |
|---|---|
| `GET /api/repos/:id/context-log` | Full WAL as Stoa-formatted markdown; also supports `?format=adr` for ADR table layout |
| `?since=<iso>` filter | Returns only entries after the given timestamp — useful for incremental export |
| `?type=<entry_type>` filter | Filter by entry type (decision, rollback, wont_do, table, observation) |
| Superseded warnings inline | Rolled-back decisions show ⚠ Superseded by `<hexId>` so readers can't miss them |
| `Content-Disposition: attachment` | Browser download works out of the box — `context_log.md` |
| Stoa + ADR dual format | `formatStoa()` renders narrative prose; `formatAdr()` renders decision tables with metadata |
| Agent file Step 0c | On-demand context log fetch added to `.claude/reasoning-layer.md` v1.6.0 |

### New VS Code command: `Reasoning Layer: Export Context Log`

Calls `GET /api/repos/:id/context-log` and writes the result to `context_log.md` in the
workspace root. Teams that want a committed, human-readable WAL in their repo can run this
after decisions land — same commit pattern as `decision.log.md` today.

The file is treated as a derived artifact (generated from Postgres, not maintained manually)
and is gitignore-able if the team prefers database-only storage.

---

## Summary

| Phase | Status | Key outcome |
|---|---|---|
| **1 — WAL Upgrade** | ✅ Shipped | `reasoningArc` + `sessionId` on Decision; rollback validation on all write paths |
| **2 — Async Refining Session** | ✅ Shipped | Fire-and-forget routing; interim table WAL entry; catch-up cadence; reviewer settles with `/settle` |
| **3 — Artifact Coherence** | ✅ Shipped | Track files → link to decisions → drift detection → pre-commit hook → superseded decision warnings |
| **4 — Agent File Cadences** | ✅ Shipped | Step 0b: pre-task drift check; Step 3c: post-decision propagation pass; drift window shrinks from days → seconds |
| **5 — Context Log Export** | ✅ Shipped | `GET /repos/:id/context-log` renders full WAL as Stoa/ADR markdown on demand from Postgres |

### Implementation order

Phase 3 can be built independently of Phase 2 — it doesn't require sessions to exist.
Recommended order: **3 → 2 → 4 → 5**, since artifact coherence delivers immediate
day-to-day value and Phase 2 sessions make Phase 4 cadences more meaningful.
