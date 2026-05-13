# Reasoning Layer — Executive Summary

## The Problem

AI coding agents (like Claude Code) move fast but often make architectural decisions without asking the right questions first — choosing the wrong data model, skipping security reviews, or picking an approach that conflicts with decisions made months ago. By the time anyone notices, the code is already written.

A second, subtler problem: even when questions get answered, the reasoning behind those answers gets lost. Teams re-litigate the same decisions months later because nobody recorded *why* a choice was made — only that it was.

A third problem emerges as the decision store grows: the AI agent has no feedback loop with the code. A decision can be recorded and then quietly ignored — the code drifts from the decision without anyone noticing until it causes an incident.

## What It Does

An ambient layer that sits between the developer and their AI agent. Every time a developer gives Claude a non-trivial task, it automatically:

1. **Intercepts the task** — submits it to a backend pipeline before Claude starts coding
2. **Classifies risk** — uses a fast LLM (Haiku) to assess risk level (`low` / `medium` / `high` / `critical`) and domain (architecture, security, product, data)
3. **Generates clarifying questions** — uses a smarter LLM (Sonnet) to surface ambiguities the developer or AI might have missed
4. **Routes to the right person** — high-risk questions are fire-and-forget: posted to Slack as a structured thread, tagged to the right reviewer, and an interim working assumption is written immediately so the developer can proceed without blocking
5. **Catches up asynchronously** — at every session start, settled answers from reviewers are surfaced as constraints before the developer describes their task
6. **Enforces coherence** — tracked files are linked to decisions; a pre-commit hook warns (or blocks) when code is committed to a tracked file that has an unimplemented decision
7. **Captures answers as reusable memory** — every answer is stored as an append-only WAL entry in Postgres with the full reasoning arc, alternatives considered, and repo scope
8. **Enriches future prompts** — before Claude answers anything, past decisions for that repo are retrieved via semantic search and prepended as hard constraints
9. **Exports the full history on demand** — the complete WAL is available as Stoa-compatible markdown via `GET /repos/:id/context-log`, giving teams a human-readable audit trail without maintaining any files manually

## The Result

Claude stops re-litigating settled decisions. Reviewers get a clean async Slack thread instead of being pulled into a call. The pre-commit hook closes the loop between the decision store and the code. And the team builds up a searchable institutional memory of *why* things were built the way they were — with the full reasoning arc, not just the conclusion.

---

## Stack

| Layer | Technology |
|---|---|
| Backend API | Fastify + Prisma + Postgres + pgvector |
| AI pipeline | Anthropic Claude — Haiku (classification), Sonnet (questions) |
| Notifications | Slack Bolt (Socket Mode) — threads, modals, reply capture |
| Frontend | Next.js 15 App Router — decision portal |
| Developer integration | VS Code extension + Claude Code agent file (fully automatic) |
| Infrastructure | EC2 + nginx, deployed at `44.200.186.86/reasoning` |

---

## Architecture Overview

```
Developer types a task in Claude Code
        │
        ▼
Step 0 — Catch-up cadence
  ├── Surface decisions that landed from Slack since last session
  └── Surface in-flight questions + working assumptions still pending

Step 0b — Pre-task drift check
  └── Compare tracked file timestamps to decision timestamps
      → If drift found: surface as hard constraints before task is described

        │
        ▼
Step 1 — Submit task → POST /api/prompts

Step 2 — POST /api/prompts/:id/analyze
  ├── Haiku: risk level + domain classification
  └── Sonnet: clarifying questions with should_escalate flag

        │
        ├── Low-risk questions → answered inline by developer → WAL entry written
        │
        └── High-risk questions → POST /api/questions/:id/route
                │
                ├── Interim `table` WAL entry written immediately
                │   (developer proceeds with working assumption — no blocking)
                │
                └── Slack session thread (async)
                    ┌─────────────────────────────────┐
                    │ 🔴 3 decisions needed from @arch │  ← top-level message
                    │   Q1 of 3 · architecture         │  ← thread reply
                    │   Q2 of 3 · security             │  ← thread reply
                    │   Q3 of 3 · data                 │  ← thread reply
                    └─────────────────────────────────┘
                            │
                            ▼ reviewer uses /settle, /wont-do, /table
                            │
                    Final WAL entry supersedes interim entry
                    FYI DM sent to developer
                    → Picked up at next session start via catch-up cadence

Step 3b — Suggest artifact links for each new decision
Step 3c — Post-decision propagation: surface linked files for immediate update

Step 4 — GET /api/prompts/:id/enriched
  └── semantic search surfaces relevant past decisions as hard constraints
        │
        ▼
Claude proceeds with full context

Pre-commit hook (installed automatically by VS Code extension)
  └── Checks staged files against drift endpoint → warn or block
```

---

## WAL Entry Types (Stoa-aligned)

Every answer is stored as an append-only WAL entry — never edited, only superseded via `rollback`.

| Type | Meaning |
|---|---|
| `decision` | Settled positive answer |
| `wont_do` | Explicit rejection ("not doing in v1") |
| `table` | Deferred to later phase |
| `branch` | Needs decomposition into sub-decisions |
| `rollback` | Supersedes a prior decision (must reference original by ID) |
| `observation` | Constraint note — no action needed |

Each entry carries: answer, rationale, alternatives considered, reopen condition, reviewer, linked files, repo, **reasoning arc** (the full dialogue that led to the decision, not just the conclusion), and session ID.

---

## Stoa Reasoning Discipline — Integration Status

Reasoning Layer is fully aligned with [Stoa](https://github.com/RelationalAI/stoa-ai) reasoning discipline. Stoa treats design as a first-class engineering activity: topics evolve through refining sessions before settling, the full reasoning arc is recorded alongside the decision, and the connection between decisions and the code that implements them is tracked and enforced.

| Phase | Status | What it adds |
|---|---|---|
| **Phase 1 — WAL Upgrade** | ✅ Shipped | `reasoningArc` field on every entry; `sessionId` FK; rollback validation enforced on all write paths |
| **Phase 2 — Async Refining Session** | ✅ Shipped | Fire-and-forget Slack routing; interim table WAL entry written immediately; `RefiningSession` + `SessionMessage` models; catch-up cadence at session start; `/settle`, `/wont-do`, `/table` reply prefixes |
| **Phase 3 — Artifact Coherence** | ✅ Shipped | `TrackedArtifact` + `ArtifactDecisionLink`; drift detection endpoint; pre-commit hook (warn/block); superseded decision warnings in enriched prompts |
| **Phase 4 — Agent File Cadences** | ✅ Shipped | Pre-task drift check (Cadence A); post-decision propagation pass (Cadence B); both injected into Claude Code agent file automatically |
| **Phase 5 — Context Log Export** | ✅ Shipped | `GET /repos/:id/context-log` renders full Postgres WAL as Stoa-compatible or ADR-style markdown on demand |

**Key design decision:** Postgres is the source of truth — no markdown WAL files to maintain. The context log is a derived view generated from the database, giving teams the human-readable audit trail without the maintenance burden.
