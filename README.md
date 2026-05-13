# Reasoning Layer

An ambient reasoning and review system that sits between a developer and an AI coding agent. It intercepts non-trivial tasks, surfaces architectural questions, routes high-risk decisions to reviewers via Slack (async — no blocking), enforces coherence between decisions and code, and stores every answer as searchable project memory — so your AI agent never re-litigates a settled decision.

→ [Executive Summary](EXECUTIVE_SUMMARY.md) · [How to Use](HOW_TO_USE.md) · [Dev conventions](CLAUDE.md)

---

## How it works

```
Developer types a task in Claude Code
        │
        ▼
Step 0 — Catch-up: surface decisions that arrived from Slack + in-flight questions
Step 0b — Drift check: surface tracked files with unimplemented decisions
        │
        ▼
Pipeline intercepts → classifies risk → generates clarifying questions
        │
        ├── Low-risk → developer answers inline → WAL entry written
        └── High-risk → interim WAL entry written, question routed to Slack (fire-and-forget)
                │
                ▼  (async — developer does not wait)
        Reviewer answers in Slack thread (/settle, /wont-do, /table)
        Final WAL entry supersedes interim; surfaced at next session start
                │
                ▼
        Future prompts automatically enriched with relevant past decisions
        Pre-commit hook enforces coherence between decisions and tracked files
```

---

## Stack

| Layer | Technology |
|---|---|
| Backend API | Fastify · Prisma · Postgres · pgvector |
| AI pipeline | Claude Haiku (classification) · Claude Sonnet (question generation) |
| Notifications | Slack Bolt — Socket Mode threads + modals |
| Frontend portal | Next.js 15 App Router |
| Developer integration | VS Code extension + Claude Code agent file (fully automatic) |
| Infrastructure | EC2 · nginx · pm2 |

---

## Monorepo structure

```
reasoning-layer/
├── packages/backend/          Fastify API, Prisma, LLM pipeline
│   ├── src/
│   │   ├── routes/            prompts.ts · questions.ts · decisions.ts
│   │   │                      sessions.ts · artifacts.ts · repos.ts · slack.ts
│   │   ├── llm/               analyzer.ts · embedder.ts · prompts.ts
│   │   ├── slack/             bolt-app.ts · message-builder.ts · routing.ts
│   │   └── db/                repos.ts
│   ├── prisma/
│   │   ├── schema.prisma
│   │   └── migrations/
│   └── scripts/
│       ├── pre-commit         coherence hook (bundled into VS Code extension)
│       └── install-coherence-hook.sh
├── packages/ui/               Next.js 15 decision portal
├── packages/vscode-extension/ VS Code extension (.vsix)
├── docs/
│   └── PHASES.md              full implementation plan — Phases 1–5 all shipped
├── EXECUTIVE_SUMMARY.md
├── HOW_TO_USE.md
└── CLAUDE.md
```

---

## Decision memory model

Every answer is stored as an **append-only WAL entry** — never edited, only superseded via `rollback`:

| Type | Meaning |
|---|---|
| `decision` | Settled positive answer |
| `wont_do` | Explicit rejection ("not doing in v1") |
| `table` | Deferred to a later phase |
| `branch` | Needs decomposition into sub-decisions |
| `rollback` | Supersedes a prior decision (must reference original) |
| `observation` | Constraint note — no action needed |

Each entry stores the answer, rationale, alternatives considered, reopen condition, reviewer, linked files, and **reasoning arc** — the full dialogue context that led to the decision, assembled from the refining session messages.

---

## API reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/prompts` | Submit a task for analysis |
| `POST` | `/api/prompts/:id/analyze` | Run LLM pipeline — classifies risk, generates questions |
| `GET` | `/api/prompts/:id` | Get prompt with questions and decisions |
| `GET` | `/api/prompts/:id/enriched` | Get prompt enriched with relevant past decisions + in-flight assumptions |
| `POST` | `/api/questions/:id/answer` | Answer a question inline |
| `POST` | `/api/questions/:id/route` | Route a question to Slack (async); writes interim WAL entry immediately |
| `POST` | `/api/questions/route-batch` | Route multiple questions under one session thread |
| `GET` | `/api/sessions/catch-up` | Settled decisions + in-flight open sessions since a timestamp |
| `GET` | `/api/sessions/:id` | Full session with messages and decisions |
| `POST` | `/api/sessions/:id/settle` | Write final WAL entry, supersede interim, close session |
| `POST` | `/api/sessions/:id/table` | Enrich interim entry with rationale, close as tabled |
| `GET` | `/api/decisions` | List decisions (`?repo=&limit=`) |
| `POST` | `/api/decisions` | Seed a standalone historical decision |
| `GET` | `/api/decisions/export` | Full ADR-style markdown export |
| `GET` | `/api/decisions/export-since` | Decisions since timestamp — used by Sync Decision Log |
| `POST` | `/api/decisions/search` | Semantic similarity search |
| `GET` | `/api/decisions/:id/linked-artifacts` | Tracked files linked to a specific decision |
| `GET` | `/api/repos/:id/artifacts` | List tracked artifacts for a repo |
| `POST` | `/api/repos/:id/artifacts` | Register a file as a tracked artifact |
| `POST` | `/api/artifacts/drift` | Check which tracked files have decisions newer than their last commit |
| `POST` | `/api/decisions/:id/link-artifacts` | Link a decision to tracked files |
| `GET` | `/api/repos/:id/context-log` | Full WAL as Stoa or ADR markdown (`?format=stoa\|adr&since=&type=`) |

---

## Development

```bash
pnpm install
pnpm dev        # backend on :3002
pnpm ui:dev     # UI on :3001
pnpm db:migrate # run pending migrations
pnpm db:studio  # open Prisma Studio
```

See [HOW_TO_USE.md](HOW_TO_USE.md) for full local setup, VS Code extension install, and Slack configuration.

---

## Stoa integration

Reasoning Layer is fully aligned with [Stoa](https://github.com/RelationalAI/stoa-ai) reasoning discipline — all five phases shipped:

| Phase | What it delivers |
|---|---|
| **1 — WAL Upgrade** | `reasoningArc` + `sessionId` on every decision; rollback validation |
| **2 — Async Refining Session** | Fire-and-forget Slack routing; interim WAL entry; catch-up cadence |
| **3 — Artifact Coherence** | Tracked files linked to decisions; drift detection; pre-commit hook |
| **4 — Agent File Cadences** | Pre-task drift check; post-decision propagation — both in the Claude Code agent file |
| **5 — Context Log Export** | Full WAL as Stoa/ADR markdown on demand from Postgres |

See [docs/PHASES.md](docs/PHASES.md) for the full implementation detail and [EXECUTIVE_SUMMARY.md](EXECUTIVE_SUMMARY.md) for the architecture overview.
