# Reasoning Layer — Executive Summary

## The Problem

AI coding agents (like Claude Code) move fast but often make architectural decisions without asking the right questions first — choosing the wrong data model, skipping security reviews, or picking an approach that conflicts with decisions made months ago. By the time anyone notices, the code is already written.

## What It Does

An ambient layer that sits between the developer and their AI agent. Every time a developer gives Claude a non-trivial task, it automatically:

1. **Intercepts the task** — submits it to a backend pipeline before Claude starts coding
2. **Classifies risk** — uses a fast LLM (Haiku) to assess risk level (`low` / `medium` / `high` / `critical`) and domain (architecture, security, product, data)
3. **Generates clarifying questions** — uses a smarter LLM (Sonnet) to surface ambiguities the developer or AI might have missed
4. **Routes to the right person** — high-risk questions get posted to Slack as a structured thread, tagged to the right reviewer (architect, PM, security)
5. **Captures answers as reusable memory** — every answer is stored in Postgres with a vector embedding, scoped to the repo it came from
6. **Enriches future prompts** — before Claude answers anything, past decisions for that repo are retrieved via semantic search and prepended as hard constraints

## The Result

Claude stops re-litigating settled decisions, reviewers get a clean Slack thread instead of being pulled into a call, and the team builds up a searchable institutional memory of *why* things were built the way they were.

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
VS Code extension writes .claude/reasoning-layer.md
        │  (agent file instructs Claude to run the pipeline)
        ▼
Claude submits task → POST /api/prompts
        │
        ▼
POST /api/prompts/:id/analyze
  ├── Haiku: risk level + domain classification
  └── Sonnet: clarifying questions with should_escalate flag
        │
        ├── Low-risk questions → answered inline by developer
        │
        └── High-risk questions → POST /api/questions/:id/route
                │
                ▼
          Slack session thread
          ┌─────────────────────────────────┐
          │ 🔴 3 decisions needed from @arch │  ← top-level message
          │   Q1 of 3 · architecture         │  ← thread reply
          │   Q2 of 3 · security             │  ← thread reply
          │   Q3 of 3 · data                 │  ← thread reply
          └─────────────────────────────────┘
                │
                ▼ reviewer replies or clicks ✏️ Answer with rationale
                │
                ▼
          Decision saved to Postgres (+ pgvector embedding)
          DM sent to developer: "Resume your Claude session"
                │
                ▼
GET /api/prompts/:id/enriched
  └── semantic search surfaces relevant past decisions
        │
        ▼
Claude proceeds with full context + hard constraints
```

---

## Entry Types (Stoa-aligned)

| Type | Meaning |
|---|---|
| `decision` | Settled positive answer |
| `wont_do` | Explicit rejection ("not doing in v1") |
| `table` | Deferred to later phase |
| `branch` | Needs decomposition into sub-decisions |
| `rollback` | Supersedes a prior decision |
| `observation` | Constraint note — no action needed |
