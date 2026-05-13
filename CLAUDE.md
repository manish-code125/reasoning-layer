@.claude/reasoning-layer.md

@stoa.md

# CLAUDE.md — Reasoning Layer

## What this project is

An ambient reasoning layer that sits alongside AI coding agents. It intercepts developer prompts, detects architectural and product ambiguity, routes unresolved questions to stakeholders via Slack, and stores answers as reusable project memory that enriches future prompts.

**Stack:** Fastify + Prisma + Postgres + pgvector (backend) · Next.js 15 App Router (UI) · pnpm workspaces monorepo.

---

## Monorepo structure

```
reasoning-layer/
├── packages/backend/     Fastify API, Prisma, LLM pipeline  (@reasoning-layer/backend)
├── packages/ui/          Next.js 15 portal                  (@reasoning-layer/ui)
├── package.json          root scripts
└── pnpm-workspace.yaml
```

---

## Dev commands

```bash
pnpm dev          # start backend (port 3002)
pnpm ui:dev       # start UI (port 3001)
pnpm db:migrate   # run Prisma migrations
pnpm db:generate  # regenerate Prisma client after schema change
pnpm db:studio    # open Prisma Studio
pnpm ui:build     # build UI locally before deploying
```

---

## EC2 deployment

- **Host:** `ubuntu@44.200.186.86`
- **Key:** `/Users/manishkumar/Documents/skills/agent_cost_optimization/deploy/tokenscope-key.pem`

**NEVER build Next.js on EC2** — only ~1.1 GB RAM available; the build crashes. Always build locally, then rsync.

```bash
# UI deploy
pnpm ui:build
rsync -az --delete packages/ui/.next/ \
  -e "ssh -i <key> -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer-ui/.next/
ssh -i <key> ubuntu@44.200.186.86 "pm2 restart reasoning-layer-ui"

# Backend deploy — sync src/ only; tsx watch auto-reloads on file change
rsync -az packages/backend/src/ \
  -e "ssh -i <key> -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer/packages/backend/src/
# No restart needed — tsx watch detects the change and restarts automatically
```

---

## pm2 processes on EC2

| Name | Port | Path |
|---|---|---|
| `reasoning-layer` | 3002 | `~/reasoning-layer/` |
| `reasoning-layer-ui` | 3001 | `~/reasoning-layer-ui/` |

---

## nginx routing on EC2

- `/` → `localhost:3001` (UI)
- `/reasoning/` → `localhost:3002/` (backend API)
- Config: `/etc/nginx/sites-available/reasoning-layer`

---

## Auth cookie rule

In [packages/ui/src/app/api/auth/login/route.ts](packages/ui/src/app/api/auth/login/route.ts):

```typescript
secure: process.env.PORTAL_SECURE_COOKIE === 'true'
```

Never use `NODE_ENV === 'production'` for this flag. `next start` always sets `NODE_ENV=production`, so the Secure flag would be applied even over plain HTTP — browsers silently drop the cookie and login breaks.

---

## Repo isolation

Decisions and prompts are scoped to a `Repo` record (table: `repos`, field: `path UNIQUE`).
- `upsertRepo(path)` in `src/db/repos.ts` — find-or-create, returns `repoId`
- `resolveRepoId(path)` — path string → `id` for query filters
- Every write path (`POST /prompts`, `POST /questions/:id/answer`, `POST /decisions`, Slack modal/thread-reply) calls `upsertRepo` and sets `repoId` on the row
- Every read path filters by `OR [{ repoId }, { linkedRepo }]` (the `linkedRepo` string column is kept for backwards compat)
- `linkedRepo` and `repoPath` string columns are deprecated but still written — prefer `repoId` FK going forward

---

## WAL discipline (Phases 1–5 — fully shipped)

Decisions are proper **append-only WAL entries**. All five Stoa integration phases are live:

- `reasoningArc String?` — the dialogue context that led to this entry. Assembled from `SessionMessage` records when a `RefiningSession` settles; `null` for fast-path Q→A answers.
- `sessionId String?` — FK to `RefiningSession`. Populated when a question is routed to Slack.
- `rollback` entries are validated across **all write paths** (REST routes + Slack modal): `supersedes_id` must reference a valid existing decision.
- `reasoning_arc` is included in all API responses, `GET /decisions/export`, `GET /decisions/export-since`, and `GET /repos/:id/context-log` markdown output.

**Shipped phases:**
- **Phase 2 — Async Refining Session:** `RefiningSession` + `SessionMessage` models; fire-and-forget routing; interim `table` WAL entry written immediately; catch-up cadence at session start; `/settle`, `/wont-do`, `/table` reply prefixes in Slack thread
- **Phase 3 — Artifact Coherence:** `TrackedArtifact` + `ArtifactDecisionLink`; `POST /artifacts/drift`; pre-commit hook (`scripts/pre-commit`); superseded decision warnings in enriched prompts
- **Phase 4 — Agent File Cadences:** Step 0b pre-task drift check (Cadence A); Step 3c post-decision propagation pass (Cadence B); both in `.claude/reasoning-layer.md` v1.6.0
- **Phase 5 — Context Log Export:** `GET /repos/:id/context-log` renders full WAL as Stoa or ADR markdown from Postgres; filters: `?since`, `?type`, `?format`

---

## Backend API conventions

- DB statuses (`unanswered`, `answered_locally`, `resolved`, `routed`) are translated to UI statuses (`pending`, `answered`, `answered`, `routed`) via `mapStatus()` in [packages/backend/src/routes/prompts.ts](packages/backend/src/routes/prompts.ts). Never return raw DB statuses to the UI.
- `POST /prompts/:id/analyze` is concurrency-guarded via `status: "analyzing"` — concurrent requests return 409.
- `GET /prompts/:id/enriched` is idempotent — second call returns cached `enrichedPrompt` immediately.

---

## LLM models

| Step | Default model | Env override |
|---|---|---|
| Classification | `claude-haiku-4-5-20251001` | `CLASSIFIER_MODEL` |
| Question generation | `claude-sonnet-4-6` | `QUESTION_MODEL` |

---

## Developer Slack ID

`U0B2TFPCRBN` (Manish) — used as `developer_slack_id` in batch routing calls and as the DM target for Slack answer notifications. Stored as `DEVELOPER_SLACK_ID` in `packages/backend/.env` on EC2.

---

## Slack answer flow

Questions are grouped into a **session thread** per routing batch:
- One top-level message is posted to the escalation channel: `"🔴 N decisions needed from @reviewer"` with the prompt as context.
- Each question is a **numbered thread reply** (`Q1 of N`, `Q2 of N`, …) so the channel stays clean and each question is individually replyable.
- Reviewers reply in the thread (plain text) **or** click `✏️ Answer with rationale` for the modal (entry type, rationale, alternatives, reopen condition).

When an answer lands:
1. Backend saves the final WAL entry to Postgres, superseding the interim `table` entry; embeds it for semantic search
2. The question message in Slack updates to ✅ answered state
3. A FYI DM is sent to the developer: *"Your next session will pick this up automatically via the catch-up cadence."*
4. At the next session start, Step 0 surfaces the settled decision as a constraint before any new task is described

---

## Decision log (`decision.log.md`)

Each developer project that uses `/decide` gets an append-only `decision.log.md` committed to its repo. The file is never edited — only appended to.

**Sync pointer:** the timestamp of the last git commit to `decision.log.md` is used as the cursor. `/decide-log` fetches only decisions created after that point.

**Backend endpoint:** `GET /api/decisions/export-since?repo=<path>&since=<iso_timestamp>`

---

## Slash commands

| Command | When to use |
|---|---|
| `/decide <task>` | Start a decision session — analyzes the task, generates questions, routes to Slack reviewers |
| `/decide-log` | Append all new decisions (since last sync) to `decision.log.md` and commit — run this after Slack answers land |

---

## VS Code Extension — Phased Plan

Extension ID: `reasoning-layer` · Publisher: to be registered on marketplace.visualstudio.com

### Phase 1 — Core (working extension, local install)

**Goal:** replace the Claude Code slash commands with native VS Code commands. Developer installs the `.vsix` file directly — no marketplace yet.

**Delivers:**
- Command: `Reasoning Layer: Analyze` — takes selected text or user input, submits to backend, opens a webview panel showing the generated questions
- Webview panel: question list with inline answer fields and "Route to Slack" buttons per question
- Command: `Reasoning Layer: Sync Decision Log` — runs the decide-log logic (git pointer → export-since → append → commit)
- **On activation: coherence hook auto-install** — when the extension activates in a workspace, it checks for `.githooks/pre-commit`. If absent, it writes the hook file (from `scripts/pre-commit`) and runs `git config core.hooksPath .githooks` silently. A one-time status bar toast confirms: `⚡ Reasoning Layer: coherence hook installed`. No manual shell command needed.
- Settings: `reasoning-layer.backendUrl`, `reasoning-layer.developerSlackId`, `reasoning-layer.hookMode` (`"warn"` | `"block"`, default `"warn"`)

**File structure:**
```
packages/vscode-extension/
├── src/
│   ├── extension.ts            activate(), register commands, auto-install hook
│   ├── api/client.ts           fetch wrapper over backend REST API
│   ├── panels/DecisionPanel.ts webview panel (vanilla HTML + JS)
│   ├── commands/analyze.ts     submit prompt → show questions
│   ├── commands/syncLog.ts     git pointer + export-since + commit
│   └── hooks/installHook.ts    write .githooks/pre-commit + set hooksPath
├── package.json                contributes, activationEvents, config
├── media/panel.css
└── scripts/pre-commit          the hook file bundled into the extension
```

**How to install locally:**
```bash
cd packages/vscode-extension
npm install
npx @vscode/vsce package        # produces reasoning-layer-x.x.x.vsix
# In VS Code: Extensions → ⋯ → Install from VSIX
```

---

### Phase 2 — Native UI

**Goal:** make decisions a first-class citizen in the VS Code sidebar, not just a panel that opens on demand.

**Delivers:**
- Status bar item: `⚡ 3 decisions pending` — click to open panel
- Sidebar tree view: past decisions for the current repo, grouped by date, searchable
- Inline CodeLens: above functions/classes that have related past decisions — `📋 2 decisions — click to view`
- Auto-sync: when a Slack DM arrives (polled via backend), status bar badge updates without developer action

---

### Phase 3 — Marketplace publish + MCP server

**Goal:** anyone can install from the VS Code marketplace; Claude uses MCP tools automatically without slash commands.

**Delivers:**

*Marketplace:*
- Register publisher at marketplace.visualstudio.com
- `npx @vscode/vsce publish` — live, searchable, one-click install
- Auto-update via marketplace versioning

*MCP server (alongside REST API on EC2):*

| Tool | What it does |
|---|---|
| `analyze_prompt(content, repo)` | Haiku + Sonnet pipeline — Claude calls this automatically when a prompt needs clarification |
| `get_relevant_decisions(text, repo)` | pgvector similarity search — Claude prepends results before answering |
| `answer_question(id, answer, rationale)` | Developer answers inline in Claude chat |
| `route_question(id, reviewer_slack_id)` | Posts to Slack thread |

*MCP resource:*
- `decisions://{repo_path}` — Claude reads full decision history for the project at session start

**With MCP wired up, the developer never types `/decide`.** Claude detects ambiguity in a prompt, calls `analyze_prompt` automatically, surfaces questions in the conversation, and calls `get_relevant_decisions` before every response to inject relevant past decisions as context.
