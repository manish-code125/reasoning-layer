// Template for .claude/reasoning-layer.md — the ambient agent instructions file.
// Written to each developer workspace on extension activation.
// The extension substitutes {{BACKEND_URL}} before writing.
// This file is spec-owned: overwritten on every activation so version updates propagate automatically.

export const AGENT_FILE_VERSION = "2.0.1";

export const AGENT_FILE_TEMPLATE = `\
# Reasoning Layer — Ambient Decision Agent v${AGENT_FILE_VERSION}

> Managed by the Reasoning Layer VS Code extension. Do NOT edit — overwritten on activation.

---

## Your job

Two modes. Use them based on context — never force the developer through a pipeline they didn't ask for.

**Default — Capture mode:** Watch this conversation for settling cues (defined below).
When a cue fires, synthesize the decision and either capture it silently or propose a WAL entry inline.
On capture, write to Postgres + append to \`context_log.md\` in the repo. No prompt submission. No question generation.

**Opt-in — Analyze mode:** Run Steps 1–4 only when the developer explicitly says
"analyze this", "generate questions for this task", or uses \`/decide\`.
Slack routing stays fully available in this mode.

Skip both modes for:
- Typo / comment / formatting edits
- Tasks prefixed with \`[skip-rl]\`
- Follow-up turns where a mode already ran for this task

---

## Settling cue detection (Capture mode — always on)

After every developer turn, scan the message (case-insensitive) for settling cues.

**Unambiguous cues — capture silently, then show one-line confirmation:**
\`locked\` · \`let's go with\` · \`settled\` · \`yes apply\` · \`go ahead\` · \`yes do it\` · \`sounds right\`

**Ambiguous cues — show proposed entry first, wait for developer confirmation:**
\`next\` · \`commit\` · \`push\` · \`compact\` · \`/clear\` · \`start fresh\` · \`let's move on\`

For ambiguous cues, show:
\`\`\`
[RL] Settling cue detected. Proposed WAL entry:
  Question: <synthesized — the decision question, one sentence>
  Answer:   <synthesized — the chosen outcome, one sentence>
  Type:     decision  (change if needed: wont_do / table / observation)

Capture this? [yes / edit / skip]
\`\`\`

On "yes" (or immediately for unambiguous cues), run the direct-capture block:

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request, os, pathlib, datetime

BACKEND = "{{BACKEND_URL}}"
repo = os.getcwd()

body = json.dumps({
    "question_text": """<synthesized question>""",
    "answer": """<synthesized answer>""",
    "entry_type": "<decision|wont_do|table|observation>",
    "rationale": """<rationale if present, else empty string>""",
    "linked_repo": repo,
}).encode()
req = urllib.request.Request(
    BACKEND + "/api/decisions",
    data=body, headers={"Content-Type": "application/json"}, method="POST"
)
resp = json.loads(urllib.request.urlopen(req).read())
hex_id = resp["hex_id"]
date_str = datetime.date.today().isoformat()

log_path = pathlib.Path(repo) / "context_log.md"
rationale_line = f"\\n**Rationale:** {resp['rationale']}" if resp.get('rationale') else ""
entry = f"\\n## \`{hex_id}\` — {resp['entry_type']} — {date_str}\\n\\n**Question:** {resp['question_text']}\\n\\n**Decision:** {resp['answer']}{rationale_line}\\n\\n---\\n"

if not log_path.exists():
    log_path.write_text(
        f"# Context Log\\n\\n> Append-only WAL. Managed by Reasoning Layer.\\n\\n---\\n{entry}",
        encoding="utf8"
    )
else:
    with open(log_path, "a", encoding="utf8") as f:
        f.write(entry)

print(f"[RL] Captured [{hex_id}] — {resp['entry_type']}")
PYEOF
\`\`\`

Then immediately run the conflict check (best-effort — never blocks):

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request, os

BACKEND = "{{BACKEND_URL}}"

try:
    url = f"{BACKEND}/api/decisions/{hex_id}/conflicts"
    cresult = json.loads(urllib.request.urlopen(url, timeout=8).read())
    cfls = cresult.get("conflicts", [])
    if cfls:
        print(f"\\n⚠  [RL] Conflict detected — {len(cfls)} existing decision(s) contradict this one:")
        for c in cfls:
            print(f"  [{c['hex_id']}] Q: {c['question_text']}")
            print(f"    A: {c['answer']}")
            print(f"    Why it conflicts: {c['reason']}")
        print("\\n  How would you like to resolve this?")
        print("  1. Rollback theirs — supersede with your decision (entry_type=rollback, supersedes_id=<their hex_id>)")
        print("  2. Route both to a Slack reviewer to arbitrate (use /decide or the extension command)")
        print("  3. Acknowledge — create an 'observation' entry noting both positions exist")
    else:
        print("[RL] No conflicts detected.")
except Exception:
    pass  # best-effort — conflict check never blocks progress
PYEOF
\`\`\`

When the developer picks a resolution:
- **Option 1 (Rollback):** Run the direct-capture block with \`entry_type=rollback\` and \`supersedes_id=<their hex_id>\`
- **Option 2 (Route to reviewer):** Use the analyze pipeline (Steps 1–4) or the VS Code "Generate Questions for Task" command
- **Option 3 (Acknowledge):** Run the direct-capture block with \`entry_type=observation\` and note both positions

After capture and conflict check, show the one-line confirmation: \`[RL] Captured [hex_id].\` then continue with the task normally.

---

## Pipeline

Use Python3 for all HTTP calls to avoid shell quoting issues with special characters.

### Step 0 — Catch-up cadence (run at session start, before every new task)

Check for decisions that landed since the last session and any still-open in-flight questions.

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request, os

BACKEND = "{{BACKEND_URL}}"
repo = os.getcwd()
since = "2020-01-01T00:00:00Z"

url = f"{BACKEND}/api/sessions/catch-up?repo={urllib.request.quote(repo)}&since={since}"
resp = json.loads(urllib.request.urlopen(url).read())

settled = resp.get("settled_since", [])
in_flight = resp.get("in_flight", [])

if settled:
    print(f"\\n✅ {len(settled)} decision(s) landed since last session:")
    for d in settled:
        print(f"  [{d['hex_id']}] {d['entry_type'].upper()}: {d['question_text']}")
        print(f"    → {d['answer']}")
        if d.get('rationale'):
            print(f"    rationale: {d['rationale']}")

if in_flight:
    print(f"\\n⏳ {len(in_flight)} question(s) still in-flight with reviewers:")
    for q in in_flight:
        print(f"  [{q['session_id'][:8]}] {q['question_text']}")
        print(f"    working assumption: {q.get('assumption', 'see interim WAL entry')}")

conflicts = resp.get("conflicts", [])
if conflicts:
    print(f"\\n⚠  {len(conflicts)} conflict(s) detected among recent decisions for this repo:")
    for c in conflicts:
        print(f"  [{c['hex_a']}] vs [{c['hex_b']}]: {c['reason']}")
    print("  Resolve via: Supersede Decision command, Slack routing, or an 'observation' WAL entry.")

if not settled and not in_flight and not conflicts:
    print("No new decisions, in-flight questions, or conflicts.")
PYEOF
\`\`\`

Surface settled decisions as constraints before describing the new task. Surface in-flight
questions so the developer knows which working assumptions are still pending. Surface conflicts
so they can be resolved before new work begins.

---

### Step 0b — Pre-task drift check (Cadence A)

Check whether any tracked files in this repo have decisions newer than their last git commit.
Run this immediately after Step 0 — before the developer describes the task — so stale
constraints are surfaced before any code is written.

\`\`\`bash
python3 << 'PYEOF'
import json, subprocess, urllib.request, os

BACKEND = "{{BACKEND_URL}}"
repo = os.getcwd()

try:
    artifacts = json.loads(urllib.request.urlopen(
        f"{BACKEND}/api/repos/{urllib.request.quote(repo, safe='')}/artifacts",
        timeout=5
    ).read())
except Exception:
    artifacts = []

if not artifacts:
    print("No tracked artifacts — drift check skipped.")
else:
    file_timestamps = {}
    for a in artifacts:
        try:
            ts = subprocess.check_output(
                ["git", "log", "-1", "--format=%cI", "--", a["file_path"]],
                text=True, cwd=repo, stderr=subprocess.DEVNULL
            ).strip()
            file_timestamps[a["file_path"]] = ts or "1970-01-01T00:00:00Z"
        except Exception:
            file_timestamps[a["file_path"]] = "1970-01-01T00:00:00Z"

    body = json.dumps({"repo_path": repo, "file_timestamps": file_timestamps}).encode()
    req = urllib.request.Request(
        f"{BACKEND}/api/artifacts/drift",
        data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        result = json.loads(urllib.request.urlopen(req, timeout=5).read())
        drifted = result.get("drifted", [])
        if drifted:
            print(f"\\n⚠  Drift detected — {len(drifted)} tracked file(s) have decisions not yet reflected in the code:\\n")
            for item in drifted:
                d = item["latest_decision"]
                print(f"  {item['file_path']}")
                print(f"    [{d['hex_id']}] {d['question_text']}")
                print(f"    → {d['answer']}")
                print(f"    decision: {d['created_at'][:10]}  |  file last committed: {item['file_last_committed_at'][:10]}")
                print()
        else:
            print("✓ No drift — all tracked files are up to date.")
    except Exception:
        print("Drift check skipped (backend unreachable).")
PYEOF
\`\`\`

If drift is found, surface the linked decisions as hard constraints before the developer
describes the task. Ask: "Before we start — these decisions may not be reflected in the
code yet. Should we address the drift first?"

---

### Step 0c — Context log (on-demand, Phase 5)

When the developer asks for the full decision history for this repo, fetch it as readable markdown:

\`\`\`bash
python3 << 'PYEOF'
import urllib.request, os

BACKEND = "{{BACKEND_URL}}"
repo = os.getcwd()

# ?format=stoa  (default) — narrative Stoa-style log
# ?format=adr           — ADR table format
# ?since=<iso>          — entries after a date
# ?type=<entry_type>    — filter by type (decision, rollback, wont_do, table, observation)
url = f"{BACKEND}/api/repos/{urllib.request.quote(repo, safe='')}/context-log?format=stoa"
print(urllib.request.urlopen(url).read().decode())
PYEOF
\`\`\`

The output is a full WAL rendered as Stoa-compatible markdown — append-only, newest entries last,
superseded decisions clearly flagged. Paste it directly into the conversation when the developer
needs a birds-eye view of all past decisions for this repo.

---

### Step 1 — Submit the task (opt-in: run only when developer explicitly requests question generation)

> Run Steps 1–4 only when the developer says "analyze this", "generate questions", or uses \`/decide\`.
> For everything else, use Capture mode (settling cue detection above).

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
- Batch remaining questions into ONE message and wait for the developer's inline answers

### Step 2b — Auto-route high-risk questions (only if should_escalate)

When routing, optionally pass the developer's working assumption so the interim WAL entry
captures what the developer is proceeding with.

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request

body = json.dumps({
    "assumption": "<what the developer is proceeding with while waiting — optional>"
}).encode()
req = urllib.request.Request('{{BACKEND_URL}}/api/questions/QUESTION_ID/route',
      data=body, headers={'Content-Type': 'application/json'}, method='POST')
print(urllib.request.urlopen(req).read().decode())
PYEOF
\`\`\`

**After routing:** the developer does NOT wait. Proceed to Step 3 for inline answers,
then Step 4. The routed question's reviewer will answer in Slack at their own pace.

### Step 3 — Capture the developer's inline answers

Only for questions the developer answers directly (not routed ones). Skip for routed questions.

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
- \`table\`       — deferred ("revisit later")
- \`observation\` — constraint note, no action needed

### Step 3b — Suggest artifact links for each new decision (Phase 3)

After capturing answers in Step 3, for each recorded decision check if there are tracked
files in this repo and suggest linking the decision to the relevant ones.

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request, os

BACKEND = "{{BACKEND_URL}}"
repo = os.getcwd()

url = f"{BACKEND}/api/repos/{urllib.request.quote(repo, safe='')}/artifacts"
try:
    artifacts = json.loads(urllib.request.urlopen(url, timeout=5).read())
except Exception:
    artifacts = []

if artifacts:
    print("Tracked files in this repo:")
    for a in artifacts:
        print(f"  {a['file_path']}  ({a.get('description') or 'no description'})")
else:
    print("No tracked files yet.")
PYEOF
\`\`\`

If tracked files exist, ask the developer: "Which of these files does decision \`<hex_id>\` govern?"
Then link the confirmed files:

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request

BACKEND = "{{BACKEND_URL}}"
body = json.dumps({"file_paths": ["<file_path_1>", "<file_path_2>"]}).encode()
req = urllib.request.Request(BACKEND + "/api/decisions/DECISION_ID/link-artifacts",
      data=body, headers={"Content-Type": "application/json"}, method="POST")
print(urllib.request.urlopen(req).read().decode())
PYEOF
\`\`\`

Skip this step if there are no tracked artifacts or the developer declines.

### Step 3c — Post-decision propagation pass (Cadence B)

For each decision recorded in Step 3, check which tracked files are already linked to it
and surface them for immediate update. This closes the loop in the same session —
the decision and the code change happen together, not days apart.

\`\`\`bash
python3 << 'PYEOF'
import json, urllib.request

BACKEND = "{{BACKEND_URL}}"

result = json.loads(urllib.request.urlopen(
    f"{BACKEND}/api/decisions/DECISION_ID/linked-artifacts", timeout=5
).read())

artifacts = result.get("artifacts", [])
if artifacts:
    print(f"\\n📎 Decision [{result['hex_id']}] is linked to {len(artifacts)} tracked file(s):")
    for a in artifacts:
        desc = f"  ({a['description']})" if a.get('description') else ""
        print(f"  {a['file_path']}{desc}")
    print("\\nAsk the developer: 'Should I update these files now to reflect this decision, or will you handle it manually?'")
    print("If yes — make the code changes, then commit. The pre-commit hook will confirm drift is resolved.")
else:
    print("No tracked files linked to this decision yet. (Link them in Step 3b if relevant.)")
PYEOF
\`\`\`

If the developer confirms, make the code changes immediately. The pre-commit hook will
verify that drift is cleared when they commit.

---

### Step 4 — Fetch enriched context, then proceed

\`\`\`bash
python3 -c "
import json, urllib.request
resp = json.loads(urllib.request.urlopen('{{BACKEND_URL}}/api/prompts/RL_ID/enriched').read())
print(resp.get('enriched_prompt', ''))
"
\`\`\`

The printed text contains:
- **Hard constraints** — decisions tied to tracked files (non-negotiable)
- **Relevant past decisions** — semantic matches (apply when relevant)
- **In-flight assumptions** — working assumptions for routed questions (provisional)

Treat hard constraints as non-negotiable. Treat in-flight assumptions as provisional —
flag them explicitly when they affect the task.
`;
