#!/usr/bin/env python3
"""
End-to-end test for the Slack session-thread routing.

Steps:
  1. Submit a prompt
  2. Analyze it (generates questions)
  3. Route ALL questions to Slack (creates session thread + numbered replies)
  4. Print the question IDs so you can verify thread-reply capture manually

Usage:
  python3 test-slack-flow.py
"""

import json, urllib.request, urllib.error, sys, time

BACKEND = "http://44.200.186.86/reasoning"
REPO    = "/Users/manishkumar/Documents/reasoning-layer"   # any existing path

def api(method, path, body=None):
    url  = BACKEND + path
    data = json.dumps(body).encode() if body is not None else None
    req  = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method=method,
    )
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  ✗ HTTP {e.code} on {method} {path}: {e.read().decode()}")
        sys.exit(1)

# ── Step 1: submit prompt ──────────────────────────────────────────────────────
print("\n1. Submitting prompt…")
prompt = api("POST", "/api/prompts", {
    "content": "Add a multi-tenant billing system: each org gets its own Stripe customer, "
               "usage-based pricing tiers, invoice generation, and a grace-period for failed payments.",
    "repo_path": REPO,
})
pid = prompt["prompt_id"]
print(f"   prompt_id = {pid}")

# ── Step 2: analyze ───────────────────────────────────────────────────────────
print("2. Analyzing (LLM call — ~10s)…")
analysis = api("POST", f"/api/prompts/{pid}/analyze", {})
questions = analysis.get("questions", [])
print(f"   risk={analysis['analysis']['risk_level']}  domain={analysis['analysis']['domain']}")
print(f"   {len(questions)} question(s) generated:")
for i, q in enumerate(questions, 1):
    print(f"   Q{i}: [{q['risk_level']}] {q['text'][:80]}")

if not questions:
    print("   No questions generated — nothing to route.")
    sys.exit(0)

# ── Step 3: fetch question IDs from DB ────────────────────────────────────────
print("3. Fetching question IDs…")
detail = api("GET", f"/api/prompts/{pid}")
db_questions = detail["questions"]

# ── Step 4: route to Slack ────────────────────────────────────────────────────
print("4. Routing questions to Slack…")
for i, dbq in enumerate(db_questions, 1):
    print(f"   Routing Q{i}: {dbq['question_id'][:8]}… ", end="", flush=True)
    result = api("POST", f"/api/questions/{dbq['question_id']}/route", {})
    print(f"status={result.get('status')}  ts={result.get('slack_message_ts', '?')[:10]}")
    if i < len(db_questions):
        time.sleep(0.5)   # small gap between routes

# ── Done ──────────────────────────────────────────────────────────────────────
print("\n✅ Done. Check Slack now:")
print("   • One session thread should have appeared in your escalation channel")
print(f"  • It contains {len(db_questions)} numbered question replies (Q1 of N … QN of N)")
print("   • Reply to any question reply in that thread → should be captured")
print("   • Or click '✏️ Answer with rationale' on any question for the modal")
print()
print("To verify capture after replying, run:")
print(f"  python3 -c \"")
print(f"  import json, urllib.request")
print(f"  r = urllib.request.urlopen('{BACKEND}/api/prompts/{pid}')")
print(f"  d = json.loads(r.read())")
print(f"  [print(q['question_id'][:8], q['status']) for q in d['questions']]")
print(f"  \"")
