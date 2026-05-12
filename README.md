# Reasoning Layer

An ambient reasoning and review system that sits between a developer and an AI coding agent. It intercepts non-trivial tasks, surfaces architectural questions, routes high-risk decisions to the right reviewers via Slack, and stores every answer as searchable project memory — so your AI agent never re-litigates a settled decision.

→ [Executive Summary](EXECUTIVE_SUMMARY.md) · [How to Use](HOW_TO_USE.md) · [Dev conventions](CLAUDE.md)

---

## How it works

```
Developer types a task in Claude Code
        │
        ▼
Pipeline intercepts → classifies risk → generates clarifying questions
        │
        ├── Low-risk → developer answers inline in Claude conversation
        └── High-risk → routed to Slack reviewer as a structured thread
                │
                ▼
        Answer saved as WAL entry in Postgres
        (reasoning arc + rationale + pgvector embedding)
                │
                ▼
        Future prompts automatically enriched with relevant past decisions
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
│   │   ├── llm/               analyzer.ts · embedder.ts · prompts.ts
│   │   ├── slack/             bolt-app.ts · message-builder.ts · routing.ts
│   │   └── db/                repos.ts
│   └── prisma/
│       ├── schema.prisma
│       └── migrations/
├── packages/ui/               Next.js 15 decision portal
├── packages/vscode-extension/ VS Code extension (.vsix)
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

Each entry stores the answer, rationale, alternatives considered, reopen condition, reviewer, linked files, and **reasoning arc** — the full dialogue context that led to the decision, not just the conclusion.

---

## API reference

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/prompts` | Submit a task for analysis |
| `POST` | `/api/prompts/:id/analyze` | Run LLM pipeline — classifies risk, generates questions |
| `GET` | `/api/prompts/:id` | Get prompt with questions and decisions |
| `GET` | `/api/prompts/:id/enriched` | Get prompt enriched with semantically relevant past decisions |
| `POST` | `/api/questions/:id/answer` | Answer a question locally |
| `POST` | `/api/questions/:id/route` | Route a question to a Slack reviewer |
| `POST` | `/api/questions/route-batch` | Route multiple questions — groups under one session thread |
| `GET` | `/api/decisions` | List decisions (`?repo=&limit=`) |
| `POST` | `/api/decisions` | Seed a standalone historical decision |
| `GET` | `/api/decisions/export` | Full ADR-style markdown export |
| `GET` | `/api/decisions/export-since` | Decisions since timestamp — used by `Sync Decision Log` |
| `POST` | `/api/decisions/search` | Semantic similarity search over the decision store |

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

Reasoning Layer is being aligned with [Stoa](https://github.com/RelationalAI/stoa-ai) reasoning discipline — adding refining sessions, artifact coherence enforcement, and pre-commit WAL auditing on top of the existing automated pipeline. See the [integration roadmap](EXECUTIVE_SUMMARY.md#stoa-reasoning-discipline--integration-roadmap).
