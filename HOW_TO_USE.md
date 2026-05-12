# How to Use — Reasoning Layer

This guide covers everything from first-time setup to day-to-day usage.

---

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Postgres with pgvector extension (local Docker or hosted RDS)
- Anthropic API key
- Slack app with Bot Token + App Token (for Slack routing — optional but recommended)

---

## 1. Backend setup (local)

```bash
# Clone and install
git clone https://github.com/manishthe/reasoning-layer
cd reasoning-layer
pnpm install

# Start Postgres with pgvector
docker-compose up -d

# Configure environment
cp packages/backend/.env.example packages/backend/.env
# Edit .env — minimum required:
#   DATABASE_URL=postgresql://...
#   ANTHROPIC_API_KEY=sk-ant-...

# Run migrations
pnpm db:migrate

# Start backend
pnpm dev
# → http://localhost:3002
```

Verify:
```bash
curl http://localhost:3002/health
# {"status":"ok"}
```

---

## 2. Slack configuration (optional but recommended)

High-risk questions are routed to Slack as structured threads. Without Slack configured, questions are answered inline only.

**Create a Slack app:**
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → Create New App → From Manifest
2. Enable **Socket Mode** and generate an App Token (`xapp-...`)
3. Add Bot Token Scopes: `chat:write`, `im:write`, `channels:read`
4. Install to your workspace — copy the Bot Token (`xoxb-...`)
5. Create or pick an escalation channel; invite the bot to it

**Add to `.env`:**
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_ESCALATION_CHANNEL=C...       # channel ID (not name)
DEFAULT_ARCH_SLACK_ID=U...          # fallback reviewer for architecture questions
DEFAULT_PM_SLACK_ID=U...            # fallback reviewer for product questions
DEVELOPER_SLACK_ID=U...             # your Slack ID — receives DMs when answers land
```

---

## 3. VS Code extension install

The extension is what makes everything automatic — it writes the Claude Code agent file on activation so the pipeline runs without any extra commands.

```bash
cd packages/vscode-extension
npm install
npx @vscode/vsce package
# produces reasoning-layer-x.x.x.vsix
```

Install in VS Code: **Extensions → ⋯ (More Actions) → Install from VSIX**

**Extension settings** (`settings.json` or VS Code Settings UI):
```json
{
  "reasoning-layer.backendUrl": "http://44.200.186.86/reasoning",
  "reasoning-layer.developerSlackId": "U0B2TFPCRBN"
}
```

On activation (opening any git repo), the extension automatically:
- Creates `.claude/reasoning-layer.md` — the agent file that instructs Claude Code to run the pipeline
- Prepends `@.claude/reasoning-layer.md` to `CLAUDE.md` (creates it if missing)

---

## 4. Using it in a new project

1. Open the project folder in VS Code
2. The extension activates on any git repo (`workspaceContains:.git`)
3. Open Claude Code (`Cmd+Shift+P → Claude Code`) and start a task as normal

Claude Code will automatically run the 4-step pipeline for any non-trivial task:

```
Step 1 — Submit the task to the backend
Step 2 — Analyze (LLM classifies risk + generates questions)
Step 2b — Auto-route high-risk questions to Slack (if should_escalate)
Step 3 — Capture developer answers for remaining questions
Step 4 — Fetch enriched context (past decisions injected as constraints)
         → Claude proceeds with the task
```

You don't need to press any keyboard shortcuts. The pipeline runs inline in your Claude Code conversation.

---

## 5. Day-to-day workflow

### Answering questions inline

For low-risk questions, Claude asks you directly in the conversation. Just reply and Claude captures the answer before proceeding.

### Answering via Slack

High-risk questions (`high` or `critical` risk level with `should_escalate: true`) are posted to your Slack escalation channel as a thread:

```
🔴 3 decisions needed from @reviewer
  Q1 of 3 · architecture   [❓ question text]   [✏️ Answer with rationale]
  Q2 of 3 · security       [❓ question text]   [✏️ Answer with rationale]
  Q3 of 3 · data           [❓ question text]   [✏️ Answer with rationale]
```

Two ways to answer:
- **Reply in the thread** — plain text reply to a question message; captured immediately
- **Click ✏️ Answer with rationale** — opens a modal with fields for entry type, answer, rationale, alternatives considered, and reopen conditions

When all answers land, you'll receive a Slack DM:
> *"✅ Decision captured — @reviewer answered in Slack. Resume your Claude session with: 'the Slack answers are in — continue with the task'"*

Go back to Claude Code and say: `"the Slack answers are in — continue with the task"`

### Syncing the decision log

After answers land, sync them to your project's `decision.log.md`:

- VS Code: `Reasoning Layer: Sync Decision Log` command
- Or use the Claude Code slash command: `/decide-log`

This appends all new decisions (since the last sync) to `decision.log.md` and commits it. The log is append-only — never edited.

---

## 6. Seeding historical decisions

If your project has existing architectural decisions you want the system to know about, seed them directly:

```bash
curl -s -X POST http://localhost:3002/api/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "question_text": "Should we use Redis or Postgres for session storage?",
    "answer": "Redis — Postgres adds too much latency on the auth path",
    "rationale": "p99 auth SLA is 50ms; Postgres at our write volume adds ~30ms",
    "entry_type": "decision",
    "linked_repo": "/path/to/your/project",
    "reasoning_arc": "Evaluated both options; Redis wins on latency, Postgres on durability. Auth tokens have short TTL so durability is less critical."
  }'
```

These decisions are immediately embedded and will surface in future prompt enrichment.

---

## 7. Searching the decision store

```bash
# Semantic search
curl -s -X POST http://localhost:3002/api/decisions/search \
  -H "Content-Type: application/json" \
  -d '{
    "text": "how should we handle session expiry",
    "repo": "/path/to/your/project",
    "limit": 5
  }' | jq .

# Full export as ADR-style markdown
curl http://localhost:3002/api/decisions/export > DECISIONS.md

# Export since a date (used by decision log sync)
curl "http://localhost:3002/api/decisions/export-since?repo=/your/project&since=2026-01-01T00:00:00Z"
```

---

## 8. EC2 deployment

The backend and UI are deployed on EC2 at `44.200.186.86`.

```bash
KEY="/Users/manishkumar/Documents/skills/agent_cost_optimization/deploy/tokenscope-key.pem"

# Deploy backend (tsx watch auto-reloads on file change — no restart needed)
rsync -az packages/backend/src/ \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer/packages/backend/src/

# Deploy prisma schema + run migrations
rsync -az packages/backend/prisma/ \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer/packages/backend/prisma/
ssh -i $KEY ubuntu@44.200.186.86 \
  "cd ~/reasoning-layer/packages/backend && npx prisma migrate deploy && npx prisma generate"

# Deploy UI (NEVER build on EC2 — build locally first)
pnpm ui:build
rsync -az --delete packages/ui/.next/ \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer-ui/.next/
ssh -i $KEY ubuntu@44.200.186.86 "pm2 restart reasoning-layer-ui"
```

**pm2 processes:**

| Name | Port |
|---|---|
| `reasoning-layer` | 3002 |
| `reasoning-layer-ui` | 3001 |

**nginx routing:**
- `/` → `localhost:3001` (UI portal)
- `/reasoning/` → `localhost:3002/` (backend API)

---

## 9. Skipping the pipeline

Prefix any Claude task with `[skip-rl]` to bypass the pipeline entirely:

```
[skip-rl] fix the typo in the README
```

The pipeline also auto-skips for typo/comment/formatting edits and follow-up turns where the pipeline already ran for the same task.

---

## 10. Troubleshooting

**Pipeline returns 500 error**
- Check backend is running: `curl http://44.200.186.86/reasoning/health`
- Check pm2 logs: `pm2 logs reasoning-layer --lines 20`
- Verify `ANTHROPIC_API_KEY` is set in `packages/backend/.env` on EC2

**Questions not appearing in Slack**
- Verify `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ESCALATION_CHANNEL` are set
- Check the bot is invited to the escalation channel
- Check pm2 logs for `[bolt]` lines

**Thread replies not captured**
- The Bolt socket listener logs every thread event: look for `[bolt] thread reply:` in pm2 logs
- If missing, Socket Mode may have disconnected — `pm2 restart reasoning-layer`

**VS Code extension using wrong backend URL**
- Open Settings → search `reasoning-layer.backendUrl`
- Ensure it's `http://44.200.186.86/reasoning` (not `localhost:3002`)

**`CLAUDE.md` not being created in a new project**
- The extension activates on `workspaceContains:.git` — make sure the folder has a `.git` directory
- Run `Reasoning Layer: Install Agent File` manually from the command palette
