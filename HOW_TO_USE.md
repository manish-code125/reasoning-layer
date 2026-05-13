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
# {"status":"ok","phase":5,...}
```

---

## 2. Slack configuration (optional but recommended)

High-risk questions are routed to Slack as structured threads. Without Slack configured, all questions are answered inline only.

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
DEVELOPER_SLACK_ID=U...             # your Slack ID — receives FYI DMs when answers land
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
  "reasoning-layer.developerSlackId": "U0B2TFPCRBN",
  "reasoning-layer.hookMode": "warn"
}
```

`hookMode` controls the coherence pre-commit hook: `"warn"` (default) prints drift warnings but lets the commit through; `"block"` prevents commits when tracked files have unimplemented decisions.

On activation (opening any git repo), the extension automatically:
- Creates `.claude/reasoning-layer.md` — the agent file that instructs Claude Code to run the pipeline
- Prepends `@.claude/reasoning-layer.md` to `CLAUDE.md` (creates it if missing)
- Installs the coherence pre-commit hook at `.githooks/pre-commit` and runs `git config core.hooksPath .githooks` — a one-time status bar toast confirms `⚡ Reasoning Layer: coherence hook installed`

No manual shell commands needed.

---

## 4. Using it in a new project

1. Open the project folder in VS Code
2. The extension activates on any git repo (`workspaceContains:.git`)
3. Open Claude Code (`Cmd+Shift+P → Claude Code`) and start a task as normal

Claude Code runs the full pipeline automatically for any non-trivial task:

```
Step 0  — Catch-up cadence: surface decisions that landed since last session + any in-flight questions
Step 0b — Pre-task drift check: surface tracked files with decisions not yet reflected in code
Step 1  — Submit the task to the backend
Step 2  — Analyze: LLM classifies risk + generates questions
Step 2b — Auto-route high-risk questions to Slack (if should_escalate) — developer does NOT wait
Step 3  — Capture developer answers for remaining questions
Step 3b — Suggest artifact links for each new decision
Step 3c — Post-decision propagation: surface tracked files linked to the new decision
Step 4  — Fetch enriched context (past decisions injected as constraints) → Claude proceeds
```

You don't need to press any keyboard shortcuts. The pipeline runs inline in your Claude Code conversation.

---

## 5. Day-to-day workflow

### Session start — catch-up cadence

At the start of every session, Claude automatically checks for:
- **Settled decisions** — answers that arrived from Slack reviewers since your last session. These are surfaced as constraints before you describe your task.
- **In-flight questions** — questions still open with reviewers. Claude surfaces the working assumption for each so you know what you're operating under.

### Answering questions inline

For low-risk questions, Claude asks you directly in the conversation. Just reply and Claude captures the answer as a WAL entry before proceeding.

### Answering via Slack (async — no blocking)

High-risk questions (`high` or `critical` with `should_escalate: true`) are fire-and-forget:

1. Claude routes the question to your Slack escalation channel as a thread and **immediately writes an interim `table` WAL entry** with a working assumption.
2. **You do not wait.** Claude proceeds with the working assumption.
3. Your reviewer answers in Slack at their own pace — plain-text thread reply, or clicking ✏️ Answer with rationale for the full modal.
4. When the answer lands, you receive a brief FYI DM: *"Your next session will pick this up automatically via the catch-up cadence."*
5. Next time you open Claude Code, the settled decision is surfaced at Step 0 before any new task.

**Reviewer answer prefixes in Slack thread:**
- `/settle <answer>` — settles as `decision`; closes the session; supersedes the interim entry
- `/wont-do <reason>` — settles as `wont_do`
- `/table` — enriches the interim entry with rationale and closes as tabled
- Plain reply — added as a session message; the session stays open for further discussion

### Pre-task drift check

Before every task, Claude checks whether any tracked files have decisions that haven't been implemented yet. If drift is found:

```
⚠ Drift detected — 1 tracked file has decisions not yet reflected in code:

  packages/backend/src/routes/auth.ts
    [a3f2e71] Should session tokens use short TTL?
    → Yes — 15-minute access token, 7-day refresh
    decision: 2026-05-10  |  file last committed: 2026-05-08
```

Claude will ask: *"Before we start — should we address the drift first?"*

### Post-decision propagation

After each decision is recorded, Claude checks which tracked files are linked to it and asks if you want to update them immediately. If you confirm, Claude makes the code changes and the pre-commit hook verifies drift is cleared on commit.

### Coherence pre-commit hook

Installed automatically by the VS Code extension. On every `git commit`, it checks staged files against the drift endpoint:

- **Warn mode** (default): prints a warning if drift is detected, but lets the commit through
- **Block mode** (`REASONING_LAYER_MODE=block`): exits 1 and prevents the commit until drift is resolved

### Viewing the full context log

Ask Claude: *"Show me the full decision history for this repo."*

Claude fetches and prints the WAL as Stoa-formatted markdown — append-only, newest entries last, with superseded decisions clearly flagged:

```markdown
## `a3f2e71` — decision — 2026-05-09

**Question:** Should we use Redis or Postgres for session storage?

**Decision:** Redis — Postgres adds too much latency on the auth path

**Rationale:** p99 auth SLA is 50ms; Postgres at our write volume adds ~30ms

---
```

You can also fetch it directly:
```bash
# Stoa format (default)
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log"

# ADR table format
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log?format=adr"

# Filter by date or type
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log?since=2026-05-01&type=decision"
```

### Syncing the decision log

After decisions land, sync them to your project's `decision.log.md`:

- VS Code: `Reasoning Layer: Sync Decision Log` command
- Or use the Claude Code slash command: `/decide-log`

This appends all new decisions (since the last sync) to `decision.log.md` and commits it. The log is append-only — never edited.

---

## 6. Tracking files (artifact coherence)

To get drift detection and post-decision propagation for specific files, register them as tracked artifacts:

```bash
BACKEND="http://44.200.186.86/reasoning"
REPO="/path/to/your/project"

curl -s -X POST "$BACKEND/api/repos/$REPO/artifacts" \
  -H "Content-Type: application/json" \
  -d '{"file_path": "packages/backend/src/routes/auth.ts", "description": "auth API routes"}'
```

Once a file is tracked, decisions can be linked to it. When the file's last git commit is older than the linked decision, drift is detected.

To link a decision to tracked files:
```bash
curl -s -X POST "$BACKEND/api/decisions/<decision-id>/link-artifacts" \
  -H "Content-Type: application/json" \
  -d '{"file_paths": ["packages/backend/src/routes/auth.ts"]}'
```

---

## 7. Seeding historical decisions

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

## 8. Searching the decision store

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

# Full context log as Stoa markdown
curl "http://localhost:3002/api/repos/<repo-id-or-path>/context-log" > context_log.md
```

---

## 9. EC2 deployment

The backend and UI are deployed on EC2 at `44.200.186.86`.

```bash
KEY="/Users/manishkumar/Documents/skills/agent_cost_optimization/deploy/tokenscope-key.pem"

# Deploy backend (tsx watch auto-reloads on file change — no restart needed for src/ changes)
rsync -az packages/backend/src/ \
  -e "ssh -i $KEY -o StrictHostKeyChecking=no" \
  ubuntu@44.200.186.86:~/reasoning-layer/packages/backend/src/

# If you added new route files, restart pm2 (tsx watch may miss new files)
ssh -i $KEY ubuntu@44.200.186.86 "pm2 restart reasoning-layer"

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

## 10. Skipping the pipeline

Prefix any Claude task with `[skip-rl]` to bypass the pipeline entirely:

```
[skip-rl] fix the typo in the README
```

The pipeline also auto-skips for typo/comment/formatting edits and follow-up turns where the pipeline already ran for the same task.

---

## 11. Troubleshooting

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

**Drift check skipped / backend unreachable**
- The pre-task drift check and pre-commit hook both gracefully skip if the backend is unreachable
- Verify the backend URL in extension settings: `reasoning-layer.backendUrl`

**VS Code extension using wrong backend URL**
- Open Settings → search `reasoning-layer.backendUrl`
- Ensure it's `http://44.200.186.86/reasoning` (not `localhost:3002`)

**`CLAUDE.md` not being created in a new project**
- The extension activates on `workspaceContains:.git` — make sure the folder has a `.git` directory
- Run `Reasoning Layer: Install Agent File` manually from the command palette

**Pre-commit hook not running**
- Verify `.githooks/pre-commit` exists and is executable (`chmod +x .githooks/pre-commit`)
- Verify `git config core.hooksPath` returns `.githooks`
- Re-open the workspace — the extension will reinstall the hook on activation if missing
