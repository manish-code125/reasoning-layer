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
# {"status":"ok","phase":7,...}
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

The extension is the primary distribution mechanism. It writes the Claude Code agent file on activation, creates `context_log.md`, and installs the pre-commit hook — everything is automatic.

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

`hookMode` controls the coherence pre-commit hook: `"warn"` (default) prints warnings but lets the commit through; `"block"` prevents commits when tracked files have unimplemented decisions or when new WAL entries conflict with existing ones.

### What happens on activation

When you open any git repo, the extension automatically:

1. Creates `.claude/reasoning-layer.md` — the agent file that instructs Claude Code how to run the pipeline
2. Adds `@.claude/reasoning-layer.md` to `CLAUDE.md` (creates it if missing) — this is how Claude Code loads the agent file automatically at every session start
3. Creates `context_log.md` in the repo root — the per-project append-only WAL in human-readable markdown
4. Installs the coherence pre-commit hook at `.githooks/pre-commit` and runs `git config core.hooksPath .githooks`

A one-time status bar toast confirms: `⚡ Reasoning Layer: initialized`

No manual shell commands needed.

---

## 4. The CLAUDE.md file

`CLAUDE.md` (in your project root) is how Claude Code knows what instructions to follow. The extension manages it for you.

When the extension activates, it prepends this line to `CLAUDE.md`:

```
@.claude/reasoning-layer.md
```

This import directive tells Claude Code to load `.claude/reasoning-layer.md` at the start of every session — the file that contains the full pipeline instructions, settling cue definitions, catch-up cadence scripts, and all Python HTTP blocks.

**You never need to edit `.claude/reasoning-layer.md` directly.** It is overwritten on every extension activation with the latest version. Changes you care about (backend URL, hook mode) are controlled via VS Code settings, not by editing the file.

If you need to add your own project-specific instructions to Claude Code, add them in `CLAUDE.md` *below* the `@.claude/reasoning-layer.md` import line. Those instructions are preserved across extension updates.

---

## 5. Using it in a new project

1. Open the project folder in VS Code
2. The extension activates on any git repo (`workspaceContains:.git`)
3. Open Claude Code and start a task as normal

From this point, two things happen automatically:

### Default — Settling-cue capture (no commands needed)

As you work with Claude Code, the agent watches for **settling cues** in the conversation. When you say something like:

- `"let's go with this"` · `"locked"` · `"settled"` · `"yes apply"` · `"go ahead"` — captured silently
- `"next"` · `"commit"` · `"let's move on"` · `"start fresh"` — prompts first:

```
[RL] Settling cue detected. Proposed WAL entry:
  Question: Should we use Postgres or Redis for session storage?
  Answer:   Postgres — simpler ops, session volume is manageable
  Type:     decision

Capture this? [yes / edit / skip]
```

On confirmation, the decision is saved to Postgres and appended to `context_log.md`. A conflict check runs immediately — if an existing decision contradicts this one, you see it with full context.

### Opt-in — Question generation pipeline

When you want the full question-generation pipeline, tell Claude explicitly:

```
Analyze this task: [describe your task]
```
or
```
Generate questions for: [describe your task]
```

Claude then runs Steps 0–4 (catch-up → drift check → submit → analyze → route → capture → enrich).

---

## 6. Day-to-day workflow

### Session start — catch-up cadence

At the start of every session, Claude automatically checks for:
- **Settled decisions** — answers that arrived from Slack reviewers since your last session
- **In-flight questions** — questions still open with reviewers, with their working assumptions
- **Conflict pairs** — contradicting decisions detected among recently settled entries

### Capturing decisions directly (VS Code command)

Outside of a Claude Code session, use the command palette:

`Reasoning Layer: Capture Decision`

This opens a quick-input flow:
1. What decision was made? (one sentence)
2. What was decided?
3. Entry type: `decision` / `wont_do` / `table` / `observation`
4. Rationale? (optional)

The entry is saved to Postgres and appended to `context_log.md`. A conflict check runs immediately — if a conflict is found, you get a VS Code warning modal with the prior decision's full context and three options:

- **Override (D1 stays)** — prompts for your rationale, then creates a new `decision` entry with `supersedes_id` pointing to D1. D1 stays in the log; full trace preserved.
- **Route to Slack** — surfaces the conflict to a reviewer for arbitration.
- **Acknowledge** — you're aware; no WAL action taken.

### The append-only WAL invariant

The decision log is **append-only**. Nothing is ever edited or deleted.

When D2 overrides D1:
- D1 stays in the log exactly as captured
- D2 is added as a new entry with `supersedes_id=D1` and an explicit rationale explaining the change
- The full evolution of thinking — D1 → D2 and why — is permanently recoverable

This means: **first-captured wins in the WAL**. If you're the second person to commit a conflicting `context_log.md`, the pre-commit hook will show you D1's full context and ask you to add an override entry first.

### Answering questions inline (opt-in pipeline)

For low-risk questions generated via the analyze pipeline, Claude asks you directly in the conversation. Reply and Claude captures the answer as a WAL entry before proceeding.

### Answering via Slack (async — no blocking)

High-risk questions (`high` or `critical` with `should_escalate: true`) are fire-and-forget:

1. Claude routes the question to your Slack escalation channel and **immediately writes an interim `table` WAL entry** with a working assumption.
2. **You do not wait.** Claude proceeds with the working assumption.
3. Your reviewer answers in Slack — plain-text thread reply, or clicking ✏️ Answer with rationale for the full modal.
4. When the answer lands, you receive a brief FYI DM.
5. Next time you open Claude Code, the settled decision is surfaced at Step 0.

**Reviewer answer prefixes in Slack thread:**
- `/settle <answer>` — settles as `decision`; supersedes the interim entry
- `/wont-do <reason>` — settles as `wont_do`
- `/table` — enriches the interim entry with rationale and closes as tabled
- Plain reply — added as a session message; session stays open for further discussion

### Pre-task drift check

Before every task, Claude checks whether any tracked files have decisions that haven't been implemented yet:

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

### Pre-commit hook — two checks

Installed automatically by the VS Code extension. On every `git commit`, it runs two checks:

**1. Artifact drift check** — checks staged files against the drift endpoint:
- Warn mode (default): prints a warning but lets the commit through
- Block mode: prevents the commit until drift is resolved

**2. WAL conflict check** — if `context_log.md` is staged, parses the diff for new WAL entry hex IDs and checks each against the conflicts endpoint:

```
[Reasoning Layer] WAL Conflict Detected
========================================================================
  Your new entry:   [b9d4a21]
  Conflicts with:   [a3f9c12]  (captured 2026-05-11)
  Their question:   Should we use Redis or Postgres for session storage?
  Their decision:   Redis — Postgres adds too much latency on the auth path
  Their rationale:  p99 auth SLA is 50ms; Postgres at our write volume adds ~30ms
  Why it conflicts: Dev A chose Redis while you chose Postgres for the same concern

========================================================================
  Decision was captured first — it stands in the WAL.
  The WAL is append-only. [b9d4a21] stays in the log.
  To make [b9d4a21] the active decision:
    * Open VS Code -> 'Reasoning Layer: Capture Decision'
    * Set type = decision, supersedes_id = a3f9c12, add your rationale.
    * This appends an override entry — full trace preserved.
```

In `block` mode, the commit is prevented. In `warn` mode (default), it proceeds with the message visible.

### Viewing the context log

Ask Claude: *"Show me the full decision history for this repo."*

Claude fetches and prints the WAL as narrative markdown from `context_log.md` (local) or `GET /repos/:id/context-log` (full Postgres WAL):

```markdown
## `a3f2e71` — decision — 2026-05-09

**Question:** Should we use Redis or Postgres for session storage?

**Decision:** Redis — Postgres adds too much latency on the auth path

**Rationale:** p99 auth SLA is 50ms; Postgres at our write volume adds ~30ms

---
```

You can also fetch directly:
```bash
# Narrative format (default)
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log"

# ADR table format
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log?format=adr"

# Filter by date or type
curl "http://44.200.186.86/reasoning/api/repos/<repo-id>/context-log?since=2026-05-01&type=decision"
```

### Syncing the decision log

After decisions land, sync `decision.log.md` and `context_log.md` together:

- VS Code: `Reasoning Layer: Sync Decision Log` command

This fetches all new decisions from the backend and commits both files. `context_log.md` gets a full replace from the canonical Postgres WAL. `decision.log.md` gets new entries appended (append-only). Both files have `merge=union` in `.gitattributes` to handle parallel branch merges cleanly.

---

## 7. Tracking files (artifact coherence)

To get drift detection and post-decision propagation for specific files, register them as tracked artifacts:

```bash
BACKEND="http://44.200.186.86/reasoning"
REPO="/path/to/your/project"

curl -s -X POST "$BACKEND/api/repos/$REPO/artifacts" \
  -H "Content-Type: application/json" \
  -d '{"file_path": "packages/backend/src/routes/auth.ts", "description": "auth API routes"}'
```

Or use the VS Code command: `Reasoning Layer: Track Current File`

Once a file is tracked, decisions can be linked to it. When the file's last git commit is older than a linked decision, drift is detected.

---

## 8. Seeding historical decisions

If your project has existing architectural decisions you want the system to know about:

```bash
curl -s -X POST http://localhost:3002/api/decisions \
  -H "Content-Type: application/json" \
  -d '{
    "question_text": "Should we use Redis or Postgres for session storage?",
    "answer": "Redis — Postgres adds too much latency on the auth path",
    "rationale": "p99 auth SLA is 50ms; Postgres at our write volume adds ~30ms",
    "entry_type": "decision",
    "linked_repo": "/path/to/your/project",
    "reasoning_arc": "Evaluated both options; Redis wins on latency, Postgres on durability."
  }'
```

These decisions are immediately available for semantic search and conflict detection.

---

## 9. Searching the decision store

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

# Full context log as narrative markdown
curl "http://localhost:3002/api/repos/<repo-id-or-path>/context-log" > context_log.md

# Conflict check for a specific decision
curl "http://localhost:3002/api/decisions/<hex-id>/conflicts"
```

---

## 10. EC2 deployment

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

## 11. Skipping the pipeline

Prefix any Claude task with `[skip-rl]` to bypass the pipeline entirely:

```
[skip-rl] fix the typo in the README
```

The pipeline also auto-skips for typo/comment/formatting edits and follow-up turns where the pipeline already ran for the same task.

---

## 12. VS Code commands reference

| Command | What it does |
|---|---|
| `Reasoning Layer: Initialize for this Repo` | Creates agent file, CLAUDE.md import, `context_log.md`, and pre-commit hook in one click |
| `Reasoning Layer: Capture Decision` | Quick-input flow to capture a decision directly to Postgres + `context_log.md` |
| `Reasoning Layer: Generate Questions for Task` | Runs the full analyze pipeline (opt-in) |
| `Reasoning Layer: Sync Decision Log` | Syncs `decision.log.md` and `context_log.md` from the backend and commits both |
| `Reasoning Layer: View Decision Log` | Opens `decision.log.md` in the editor |
| `Reasoning Layer: Enrich with Past Decisions` | Fetches enriched context for the active prompt |
| `Reasoning Layer: List Pending Questions` | Shows open questions for this repo |
| `Reasoning Layer: Track Current File` | Registers the active file as a tracked artifact |
| `Reasoning Layer: Check Artifact Drift` | Runs a manual drift check for this repo |
| `Reasoning Layer: Generate Coherence Hook` | (Re)writes `.githooks/pre-commit` with current settings |
| `Reasoning Layer: Supersede a Decision` | Marks an existing decision as superseded |

---

## 13. Troubleshooting

**Pipeline returns 500 error**
- Check backend is running: `curl http://44.200.186.86/reasoning/health`
- Check pm2 logs: `pm2 logs reasoning-layer --lines 20`
- Verify `ANTHROPIC_API_KEY` is set in `packages/backend/.env` on EC2

**Questions not appearing in Slack**
- Verify `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_ESCALATION_CHANNEL` are set
- Check the bot is invited to the escalation channel
- Check pm2 logs for `[bolt]` lines

**Conflict check returns `mode: "unavailable"`**
- Conflict detection requires `ANTHROPIC_API_KEY` — it's the same key used for question generation

**Pre-commit hook WAL check not running**
- Verify `context_log.md` is actually staged (`git diff --cached --name-only`)
- Check the hook file has the WALEOF block: `cat .githooks/pre-commit`
- Re-run `Reasoning Layer: Generate Coherence Hook` to regenerate the hook with current settings

**`CLAUDE.md` not being created in a new project**
- The extension activates on `workspaceContains:.git` — make sure the folder has a `.git` directory
- Run `Reasoning Layer: Initialize for this Repo` manually from the command palette

**Pre-commit hook not running**
- Verify `.githooks/pre-commit` exists and is executable (`chmod +x .githooks/pre-commit`)
- Verify `git config core.hooksPath` returns `.githooks`
- Re-open the workspace — the extension reinstalls the hook on activation if missing

**VS Code extension using wrong backend URL**
- Open Settings → search `reasoning-layer.backendUrl`
- Ensure it matches `http://44.200.186.86/reasoning` (no trailing slash)
