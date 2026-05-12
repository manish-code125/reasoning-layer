# AI Engineering Reasoning Layer

An ambient reasoning layer that sits alongside AI coding agents. It captures developer prompts, detects architectural and product ambiguity, routes unresolved questions to PMs and architects via Slack, and stores answers as reusable project memory that enriches future prompts.

> **Design assumption:** Using Fastify instead of Express — same Node.js ecosystem, TypeScript-first, better performance, consistent with the existing async-clarification tooling in this repo.

---

## Phase 1 — Backend Skeleton

**What this phase delivers:** Postgres schema (with pgvector column ready for Phase 4), Fastify REST API with all endpoints stubbed correctly, full data model wired through Prisma. No LLM calls yet — Phase 2 makes the analysis real.

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Docker or OrbStack (for Postgres)

### File tree

```
reasoning-layer/
├── docker-compose.yml          Postgres + pgvector
├── .env.example
├── pnpm-workspace.yaml
├── package.json                root scripts
└── packages/
    └── backend/
        ├── package.json
        ├── tsconfig.json
        ├── prisma/
        │   └── schema.prisma   Prompt, Question, Decision models
        └── src/
            ├── index.ts        Fastify server + route registration
            ├── db.ts           Prisma client singleton
            ├── types.ts        Shared TypeScript interfaces
            └── routes/
                ├── prompts.ts  POST/GET /api/prompts/*
                ├── questions.ts POST /api/questions/:id/answer|route
                └── decisions.ts GET/POST /api/decisions/*
```

### Setup

```bash
# 1. Start Postgres with pgvector
docker-compose up -d

# 2. Install dependencies
pnpm install

# 3. Copy env file — DATABASE_URL default works as-is with docker-compose
cp .env.example .env

# 4. Run database migrations (creates schema + enables vector extension)
pnpm db:migrate
# When prompted for a migration name, enter: init

# 5. Start the backend
pnpm dev
```

### Verify

```bash
# Health check
curl http://localhost:3002/health
# {"status":"ok","phase":1}

# Submit a prompt
curl -s -X POST http://localhost:3002/api/prompts \
  -H "Content-Type: application/json" \
  -d '{
    "content": "Build a multi-tenant billing reconciliation service",
    "repo_path": "/projects/billing",
    "language": "typescript"
  }' | jq .
# Returns: { "prompt_id": "<uuid>", "status": "pending", ... }

# Trigger stub analysis (generates 3 placeholder questions)
PROMPT_ID=<paste prompt_id here>
curl -s -X POST http://localhost:3002/api/prompts/$PROMPT_ID/analyze | jq .

# Check generated questions
curl -s http://localhost:3002/api/prompts/$PROMPT_ID/questions | jq .

# Answer a question locally
QUESTION_ID=<paste question_id>
curl -s -X POST http://localhost:3002/api/questions/$QUESTION_ID/answer \
  -H "Content-Type: application/json" \
  -d '{
    "answer": "Asynchronous via SQS — billing can tolerate 1-2s delay",
    "rationale": "Sync adds latency on the checkout path; SQS gives a retry buffer for free"
  }' | jq .

# Route a high-risk question to Slack (stub — Phase 3 makes this real)
curl -s -X POST http://localhost:3002/api/questions/$QUESTION_ID/route \
  -H "Content-Type: application/json" \
  -d '{"reviewer_slack_id": "UXXXXX"}' | jq .

# Check the decision store
curl -s http://localhost:3002/api/decisions | jq .

# Seed a historical decision manually
curl -s -X POST http://localhost:3002/api/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "question_text": "Should we use Redis or Postgres for session tokens?",
    "answer": "Redis — Postgres adds latency we cannot afford at auth scale",
    "rationale": "p99 auth latency SLA is 50ms; Postgres at our write volume adds ~30ms",
    "linked_repo": "/projects/billing"
  }' | jq .
```

---

## API Reference (Phase 1)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| POST | `/api/prompts` | Submit a prompt for analysis |
| GET | `/api/prompts/:id` | Get prompt with questions and decisions |
| POST | `/api/prompts/:id/analyze` | Trigger analysis (stub → Phase 2 LLM) |
| GET | `/api/prompts/:id/questions` | Get questions ordered by risk level |
| GET | `/api/prompts/:id/enriched` | Get enriched prompt (stub → Phase 5 pgvector) |
| POST | `/api/questions/:id/answer` | Answer a question locally, creates Decision |
| POST | `/api/questions/:id/route` | Route to Slack reviewer (stub → Phase 3 Bolt) |
| GET | `/api/decisions` | List decisions (?repo=&limit=) |
| GET | `/api/decisions/:id` | Get a specific decision |
| POST | `/api/decisions` | Seed a standalone historical decision |

---

## Phase 2 — Prompt Analysis Pipeline

**New files:** `src/llm/prompts.ts` (templates), `src/llm/analyzer.ts` (pipeline)
**Modified:** `src/routes/prompts.ts` (analyze endpoint is now real)

### Additional setup

Add your Anthropic API key to `.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### How it works

`POST /api/prompts/:id/analyze` now makes two sequential Claude API calls:

1. **Classify** (Haiku — fast/cheap): sends the prompt + repo context, receives structured JSON:
   ```json
   { "domain": "billing", "risk_level": "high", "architectural_impact": "high",
     "product_ambiguity": "medium", "surfaced_concerns": ["audit", "multi-tenancy", "consistency"] }
   ```

2. **Generate questions** (Sonnet — better reasoning): uses the classification as context,
   generates 3–6 targeted questions with `risk_level` and `should_escalate` per question.

Question count scales with risk: `low→3, medium→4, high→5, critical→6`.

### Demo

```bash
# Submit and analyze a real prompt
curl -s -X POST http://localhost:3002/api/prompts \
  -H "Content-Type: application/json" \
  -d '{"content":"Build a multi-tenant billing reconciliation service","repo_path":"/projects/billing","language":"typescript"}' | jq .

PROMPT_ID=<from above>

curl -s -X POST http://localhost:3002/api/prompts/$PROMPT_ID/analyze | jq .
# Returns real domain classification, risk score, and 5 targeted questions
# Each question has: text, category, risk_level, should_escalate
```

### Prompt templates

The exact prompts sent to Claude are in [`src/llm/prompts.ts`](packages/backend/src/llm/prompts.ts) —
readable, testable, and tunable without touching any other code.

Override models via env:
```
CLASSIFIER_MODEL=claude-haiku-4-5-20251001   # default
QUESTION_MODEL=claude-sonnet-4-6              # default
```

## Phase 3 — Slack Integration *(coming)*

Replaces `POST /api/questions/:id/route` stub. Delivers:
- Slack Bolt in Socket Mode (no public URL needed)
- Message with original prompt + question + Answer button
- Modal capture → decision persisted → developer notified in VS Code

## Phase 4 — Decision Memory + pgvector Retrieval *(coming)*

Embeds decisions on creation. Delivers:
- Embedding generation via Anthropic `text-embedding-3-small`
- `GET /api/decisions?prompt_id=<id>` triggers similarity search
- Top-K relevant decisions returned by cosine similarity

## Phase 5 — Prompt Enrichment *(coming)*

Wires `GET /api/prompts/:id/enriched`. Delivers:
- Embed new prompt, retrieve top-3 decisions scoped to same repo
- Produces enriched prompt block the extension hands to the AI tool

## Phase 6 — VS Code / Cursor Extension *(coming)*

TypeScript extension. Delivers:
- "Analyze this prompt" command
- Quick-pick showing clarification questions
- One-click Slack routing
- Enriched context injected before the developer sends to their AI tool
