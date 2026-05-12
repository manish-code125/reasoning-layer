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

## Phase 2 — Refining Session

**Goal:** A topic can evolve through multi-turn dialogue before settling into a WAL entry.
The Slack thread becomes the refining session — each reply adds a turn, settling produces
the WAL entry.

### New schema

```prisma
model RefiningSession {
  id          String           @id @default(uuid())
  promptId    String
  prompt      Prompt           @relation(fields: [promptId], references: [id])
  questionId  String?          @unique
  question    Question?        @relation(fields: [questionId], references: [id])
  topic       String           // short label for the topic being refined
  // open | settled | branched | tabled | abandoned
  status      String           @default("open")
  // decision | wont_do | table | branch | rollback | observation
  outcome     String?
  createdAt   DateTime         @default(now())
  settledAt   DateTime?
  messages    SessionMessage[]
  decisions   Decision[]

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

### New API endpoints

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/sessions` | Start a refining session for a question or open topic |
| `GET` | `/api/sessions/:id` | Full session state + message history |
| `POST` | `/api/sessions/:id/messages` | Add a dialogue turn (developer, reviewer, or AI) |
| `POST` | `/api/sessions/:id/settle` | Settle → creates WAL entry; `reasoning_arc` assembled from message history |
| `POST` | `/api/sessions/:id/branch` | Decompose → creates N child sessions; parent marked `branched` |
| `POST` | `/api/sessions/:id/table` | Defer → creates a `table` WAL entry; session marked `tabled` |
| `POST` | `/api/sessions/:id/abandon` | Explicitly close without a WAL entry |

### Slack flow upgrade

Today a Slack thread reply immediately closes the question. With sessions:

- A Slack thread **is** the refining session — each reply adds a `SessionMessage`
- Settling is triggered by a `/settle`, `/table`, or `/wont-do` reply prefix, or by clicking
  a new **Settle** button added to the question block
- Until settled, replies accumulate as turns and no WAL entry is written
- The `reasoning_arc` on the final WAL entry is assembled from the full `SessionMessage` history

### Fast path preserved

`POST /api/questions/:id/route` with a single reply still works as before — it opens a session
and immediately settles it. Backwards compatible; no API changes for existing callers.

### Agent file additions (Step 2 upgrade)

```python
# After routing — Claude can participate in multi-turn sessions:
POST /sessions/:id/messages  { "role": "ai", "content": "..." }

# When session is ready to settle:
POST /sessions/:id/settle    {
  "outcome": "decision",
  "answer": "...",
  "rationale": "...",
  "reasoning_arc": "Assembled summary of the dialogue arc"
}
```

---

## Phase 3 — Artifact Coherence

**Goal:** Track which files in a repo are governed by which decisions. Surface drift when code
moves ahead of the WAL. Optionally block commits to tracked files without a corresponding WAL entry.

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

---

## Phase 4 — Agent File Coherence Cadences

**Goal:** Add two Stoa-style coherence cadences to the Claude Code agent file
(`.claude/reasoning-layer.md`) so drift is surfaced proactively without developer action.

### Cadence A — Pre-task drift check

Runs **before Step 1** (before submitting the task):

```python
# Check if any open files are tracked artifacts with stale decisions
python3 -c "
import json, urllib.request
BACKEND = '{{BACKEND_URL}}'
repo = os.getcwd()
# Pass open file path if available
req = urllib.request.Request(
  BACKEND + '/api/repos/by-path/artifacts/drift?repo=' + repo,
  headers={'Content-Type': 'application/json'}, method='GET')
result = json.loads(urllib.request.urlopen(req).read())
if result['drifted']:
    print('⚠ Drift detected — these decisions may not be reflected in your code:')
    for d in result['drifted']:
        print(f'  {d[\"file_path\"]} ← decision {d[\"latest_decision\"][\"hex_id\"]}: {d[\"latest_decision\"][\"question_text\"]}')
"
```

If drift is found, Claude surfaces the linked decisions as constraints **before** asking the
developer to confirm the task — not after the code is already written.

### Cadence B — Post-decision propagation pass

Runs **after Step 3** (after answers are captured):

```
After each WAL entry is written, check if any tracked artifacts are linked to the
settled topic. Surface files that may need updating to reflect the new decision:

"Decision a3f2e71 was just settled. The following tracked files may need updating:
  - packages/backend/prisma/schema.prisma (linked to this decision)
  - packages/backend/src/routes/decisions.ts (linked to this decision)
Should I update them, or will you handle it manually?"
```

This mirrors Stoa's cadence #2 (post-decision propagation pass) but automated via the pipeline.

### Agent file version bump

These cadences are added to `.claude/reasoning-layer.md` as a v1.3.0 update. The VS Code
extension writes the new version on next activation.

---

## Phase 5 — Context Log Export

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
| **2 — Refining Session** | Planned | Multi-turn dialogue before settlement; Slack thread = session |
| **3 — Artifact Coherence** | Planned | Track files → link to decisions → drift detection → pre-commit hook |
| **4 — Agent File Cadences** | Planned | Pre-task drift check + post-decision propagation pass in agent file |
| **5 — Context Log Export** | Planned | Stoa-compatible markdown WAL generated from Postgres on demand |

### Implementation order

Phase 3 can be built independently of Phase 2 — it doesn't require sessions to exist.
Recommended order: **3 → 2 → 4 → 5**, since artifact coherence delivers immediate
day-to-day value and Phase 2 sessions make Phase 4 cadences more meaningful.
