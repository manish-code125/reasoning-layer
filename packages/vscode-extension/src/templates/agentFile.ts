// Template for .claude/reasoning-layer.md — the ambient agent instructions file.
// Written to each developer workspace on extension activation.
// The extension substitutes {{BACKEND_URL}} before writing.
// This file is spec-owned: overwritten on every activation so version updates propagate automatically.

export const AGENT_FILE_VERSION = "1.2.0";

export const AGENT_FILE_TEMPLATE = `\
# Reasoning Layer — Ambient Decision Agent v${AGENT_FILE_VERSION}

> Managed by the Reasoning Layer VS Code extension. Do NOT edit — overwritten on activation.

---

## Your job

Before acting on any non-trivial developer task, run the four-step pipeline below
using your Bash tool. Everything happens inline in this conversation — the developer
should never need to open another tool or press any keyboard shortcut.

Skip the pipeline only for:
- Typo / comment / formatting edits
- Tasks prefixed with \`[skip-rl]\`
- Follow-up turns where the pipeline already ran for this task

---

## Pipeline

Use Python3 for all HTTP calls to avoid shell quoting issues with special characters.

### Step 1 — Submit the task

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request, os, urllib.error

BACKEND = "{{BACKEND_URL}}"
task = """<developer task — paste verbatim here using triple quotes>"""
body = json.dumps({"content": task, "repo_path": os.getcwd()}).encode()
req = urllib.request.Request(BACKEND + "/api/prompts", data=body,
      headers={"Content-Type": "application/json"}, method="POST")
resp = json.loads(urllib.request.urlopen(req).read())
print(resp["prompt_id"])
PYEOF
\`\`\`

Capture the printed prompt_id as \`RL_ID\`.

### Step 2 — Analyze (risk classification + question generation)

\`\`\`bash
python3 -c "
import json, urllib.request
BACKEND = '{{BACKEND_URL}}'
req = urllib.request.Request(BACKEND + '/api/prompts/RL_ID/analyze',
      data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
print(urllib.request.urlopen(req).read().decode())
"
\`\`\`

From the JSON response:
- Show ALL questions inline with risk emoji: 🔴 critical · 🟠 high · 🟡 medium · 🟢 low
- For any question where \`should_escalate\` is true → run Step 2b immediately, no need to ask
- Batch remaining questions into ONE message and wait for the developer's answers

### Step 2b — Auto-route high-risk questions (only if should_escalate)

\`\`\`bash
python3 -c "
import urllib.request
req = urllib.request.Request('{{BACKEND_URL}}/api/questions/QUESTION_ID/route',
      data=b'{}', headers={'Content-Type': 'application/json'}, method='POST')
urllib.request.urlopen(req).read()
"
\`\`\`

### Step 3 — Capture the developer's answers

For each answer the developer gives in this thread:

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request

BACKEND = "{{BACKEND_URL}}"
body = json.dumps({
    "answer": """<answer verbatim>""",
    "entry_type": "<decision|wont_do|table|observation>",
    "rationale": "<optional: why>",
    "alternatives_considered": "<optional>",
    "reopen_condition": "<optional: when to revisit>"
}).encode()
req = urllib.request.Request(BACKEND + "/api/questions/QUESTION_ID/answer",
      data=body, headers={"Content-Type": "application/json"}, method="POST")
print(urllib.request.urlopen(req).read().decode())
PYEOF
\`\`\`

entry_type guide:
- \`decision\`    — settled positive answer (default)
- \`wont_do\`     — explicit rejection ("not doing in v1")
- \`table\`       — deferred ("Phase 2")
- \`observation\` — constraint note, no action needed

### Step 4 — Fetch enriched context, then proceed

\`\`\`bash
python3 -c "
import json, urllib.request
resp = json.loads(urllib.request.urlopen('{{BACKEND_URL}}/api/prompts/RL_ID/enriched').read())
print(resp.get('enriched_prompt', ''))
"
\`\`\`

The printed text contains past decisions for this repo. Treat them as hard constraints —
mention any directly relevant ones, then proceed with the task.
`;
