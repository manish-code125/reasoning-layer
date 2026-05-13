# Reasoning Layer — Executive Summary

## The Problem

AI coding agents (like Claude Code) move fast but often make architectural decisions without asking the right questions first — choosing the wrong data model, skipping security reviews, or picking an approach that conflicts with decisions made months ago. By the time anyone notices, the code is already written.

A second, subtler problem: even when questions get answered, the reasoning behind those answers gets lost. Teams re-litigate the same decisions months later because nobody recorded *why* a choice was made — only that it was.

A third problem emerges as the decision store grows: the AI agent has no feedback loop with the code. A decision can be recorded and then quietly ignored — the code drifts from the decision without anyone noticing until it causes an incident.

A fourth problem appears in team settings: two developers working in parallel can capture contradicting decisions independently. Neither is informed of the conflict until it surfaces as a bug or a hard-to-trace regression.

## What It Does

An ambient reasoning layer that sits between the developer and their AI agent. It has two modes that complement each other:

### Default — Capture mode (conversation-native)

The agent watches your conversation for **settling cues** — phrases like "let's go with this", "locked", "go ahead", "yes apply". When one fires:

1. It synthesizes the decision that just settled
2. Proposes a WAL entry inline (question, answer, entry type)
3. On confirmation, captures it directly to Postgres and appends it to `context_log.md`
4. Checks for conflicts with existing decisions in the same repo — if found, surfaces them immediately with the prior decision's full context (question, answer, rationale, conflict reason) and offers three resolution paths: override, route to Slack, or acknowledge

No prompt submission. No question generation pipeline. One conversation turn.

### Opt-in — Analyze mode

When the developer explicitly says "analyze this task", "generate questions", or uses a question-generation command:

1. **Submits the task** to the backend pipeline
2. **Classifies risk** — Haiku assesses risk level and domain
3. **Generates clarifying questions** — Sonnet surfaces ambiguities the developer or AI might have missed
4. **Routes high-risk questions to Slack** — fire-and-forget: posted as a structured thread, reviewer tagged, interim working assumption written immediately so the developer can proceed without blocking
5. **Catches up asynchronously** — at every session start, settled answers from reviewers are surfaced as constraints before the developer describes their task

### Always-on — Coherence enforcement

Regardless of which mode is active:

- **Pre-task drift check** — before every task, tracked files are compared to decision timestamps; stale constraints are surfaced before any code is written
- **Pre-commit hook** — when `context_log.md` is staged, the hook checks each new WAL entry against the decision store for conflicts; shows the prior decision's full rationale, explains the append-only invariant, and blocks or warns based on configuration
- **Artifact coherence** — tracked files are linked to decisions; drift is detected when a file's last commit is older than a linked decision
- **Prompt enrichment** — past decisions for the repo are retrieved via semantic search and prepended as hard constraints before Claude answers anything

## The Result

Claude stops re-litigating settled decisions. Developers capture decisions naturally in conversation without switching tools. Reviewers get a clean async Slack thread when escalation is genuinely needed. Conflicting decisions are caught at the moment they're committed — with the full context of why the prior decision was made — not weeks later. And the team builds up a searchable institutional memory of *why* things were built the way they were, with the full reasoning arc intact and append-only.

---

## Stack

| Layer | Technology |
|---|---|
| Backend API | Fastify + Prisma + Postgres + pgvector |
| AI pipeline | Anthropic Claude — Haiku (classification, conflict detection), Sonnet (questions) |
| Notifications | Slack Bolt (Socket Mode) — threads, modals, reply capture |
| Frontend | Next.js 15 App Router — decision portal |
| Developer integration | VS Code extension + Claude Code agent file (fully automatic) |
| Infrastructure | EC2 + nginx, deployed at `44.200.186.86/reasoning` |

---

## Architecture Overview

```
Developer types in Claude Code
        │
        ▼
Step 0 — Catch-up cadence
  ├── Surface decisions that landed from Slack since last session
  ├── Surface in-flight questions + working assumptions still pending
  └── Surface conflict pairs detected among recently settled decisions

Step 0b — Pre-task drift check
  └── Compare tracked file timestamps to decision timestamps
      → If drift found: surface as hard constraints before task is described

        │
        ├─── [Settling cue detected — Capture mode, default]
        │         │
        │         ▼
        │    Synthesize WAL entry → confirm with developer
        │         │
        │         ▼
        │    POST /api/decisions (questionId=null — direct capture)
        │    Append to context_log.md
        │         │
        │         ▼
        │    GET /api/decisions/:id/conflicts
        │    ├── No conflicts → show [RL] Captured [hex_id]
        │    └── Conflicts found → show prior decision's Q/A/rationale
        │                         → Override (D1 stays) / Route to Slack / Acknowledge
        │
        └─── [Developer explicitly requests questions — Analyze mode, opt-in]
                  │
                  ▼
             Step 1 — Submit task → POST /api/prompts
             Step 2 — POST /api/prompts/:id/analyze
               ├── Haiku: risk level + domain classification
               └── Sonnet: clarifying questions with should_escalate flag

                  │
                  ├── Low-risk questions → answered inline → WAL entry written
                  │
                  └── High-risk questions → POST /api/questions/:id/route
                          │
                          ├── Interim `table` WAL entry written immediately
                          │   (developer proceeds with working assumption — no blocking)
                          │
                          └── Slack session thread (async)
                              ┌─────────────────────────────────┐
                              │ 🔴 3 decisions needed from @arch │
                              │   Q1 of 3 · architecture         │
                              │   Q2 of 3 · security             │
                              │   Q3 of 3 · data                 │
                              └─────────────────────────────────┘
                                      │
                                      ▼ reviewer uses /settle, /wont-do, /table
                                      │
                              Final WAL entry supersedes interim entry
                              FYI DM sent to developer
                              → Picked up at next session start via catch-up cadence

Pre-commit hook (installed automatically by VS Code extension)
  ├── Drift check: staged files → artifact drift endpoint → warn or block
  └── WAL conflict check: staged context_log.md → new hex IDs → /decisions/:id/conflicts
        → Shows prior decision Q/A/rationale/capture date
        → Explains append-only invariant + how to add an override entry
        → Warns (default) or blocks (hookMode=block)
```

---

## WAL Entry Types

Every decision is stored as an append-only WAL entry — never edited, never deleted. The full trace of overrides is always recoverable.

| Type | Meaning |
|---|---|
| `decision` | Settled positive answer — including overrides of prior decisions |
| `wont_do` | Explicit rejection ("not doing in v1") |
| `table` | Deferred to a later phase |
| `branch` | Needs decomposition into sub-decisions |
| `rollback` | Explicit reversal of a prior decision (must reference original by ID) |
| `observation` | Constraint note — no action needed |

Each entry carries: answer, rationale, alternatives considered, reopen condition, reviewer, linked files, repo, **reasoning arc** (the full dialogue that led to the decision), and session ID.

**The append-only invariant:** When D2 overrides D1, D1 is never edited or removed. D2 is a new entry with `supersedes_id=D1` and an explicit rationale. Both decisions remain in the log — the evolution of thinking is always recoverable.

---

## Conflict Detection

Conflict detection runs at two points:

| When | How | Surface |
|---|---|---|
| **Capture time** | After any decision is saved, `GET /decisions/:id/conflicts` runs a semantic similarity + LLM contradiction check against recent decisions in the same repo | Inline in the conversation or VS Code warning modal |
| **Commit time** | Pre-commit hook parses `git diff --cached context_log.md`, extracts new hex IDs, calls conflicts endpoint for each | Terminal output with full prior decision context |

In both cases, the message is the same: *"D1 was captured first — it stands. The WAL is append-only. To make your decision active, add an override entry that supersedes D1 — the full trace is preserved."*

---

## Implementation Status

The Reasoning Layer treats design as a first-class engineering activity: topics evolve through conversation before settling, the full reasoning arc is recorded alongside the decision, and the connection between decisions and the code that implements them is tracked and enforced.

| Phase | Status | What it adds |
|---|---|---|
| **Phase 1 — WAL Upgrade** | ✅ Shipped | `reasoningArc` field; `sessionId` FK; rollback validation on all write paths |
| **Phase 2 — Async Refining Session** | ✅ Shipped | Fire-and-forget Slack routing; interim WAL entry; catch-up cadence; `/settle`, `/wont-do`, `/table` reply prefixes |
| **Phase 3 — Artifact Coherence** | ✅ Shipped | `TrackedArtifact` + `ArtifactDecisionLink`; drift detection; pre-commit hook; superseded decision warnings |
| **Phase 4 — Agent File Cadences** | ✅ Shipped | Pre-task drift check (Cadence A); post-decision propagation (Cadence B); agent file v2.x |
| **Phase 5 — Context Log Export** | ✅ Shipped | `GET /repos/:id/context-log` renders full Postgres WAL as narrative or ADR markdown |
| **Phase 6 — Conversation-native Capture** | ✅ Shipped | Settling-cue detection; direct WAL capture; `captureDecision` VS Code command; `context_log.md` per repo; question generation opt-in |
| **Phase 7 — Conflict Detection** | ✅ Shipped | Capture-time + commit-time conflict detection; append-only override flow; rationale surfaced at conflict; pre-commit WAL check |

**Key design decisions:**
- Postgres is the source of truth — no markdown WAL files to maintain. `context_log.md` is a derived view that agents and developers can read without calling the API.
- Conflict detection is query-time (no persistence) — LLM reranking over recent decisions, no pgvector required.
- First-captured wins — the `created_at` timestamp in Postgres determines precedence; the pre-commit hook enforces this at commit time.
