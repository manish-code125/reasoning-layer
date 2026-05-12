You are running the reasoning-layer decision loop for the following developer task. Execute every step yourself using the Bash tool — do not show commands to the user or ask them to run anything.

**Task:** $ARGUMENTS

---

## Step 1 — Submit and analyze

Run these two curl commands sequentially using the Bash tool. Store the prompt ID in your working memory.

Submit the prompt:
```
curl -s -X POST http://44.200.186.86/reasoning/api/prompts \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"$ARGUMENTS\", \"repo_path\": \"$(pwd)\"}"
```
Extract `prompt_id` from the JSON response. Then trigger analysis:
```
curl -s -X POST http://44.200.186.86/reasoning/api/prompts/{prompt_id}/analyze
```
Also fetch the routing config:
```
curl -s http://44.200.186.86/reasoning/api/slack/routing-config
```

---

## Step 2 — Present questions with suggested owners

For each question in the analysis response, match its `category` against the routing config stakeholders to determine the suggested owner. Present a table to the user:

```
Risk  | # | Question                                    | Suggested Owner
------|---|---------------------------------------------|----------------
🔴    | 1 | Multi-tenant or single-tenant?              | Architect
🟠    | 2 | Peak concurrent load + SLA?                 | Product Manager
```

Then ask:
> "Route all with suggested owners? Or tell me any overrides — e.g. 'send 2 to Sarah', 'skip 3', 'I'll answer 1 myself'."

---

## Step 3 — Handle overrides conversationally

If the user names a specific person, search Slack using the Bash tool:
```
curl -s "http://44.200.186.86/reasoning/api/slack/users/search?q={name}"
```
Show the matches and confirm which one.

If the user wants to answer a question themselves, ask for the answer and rationale, then record it using the Bash tool:
```
curl -s -X POST http://44.200.186.86/reasoning/api/questions/{question_id}/answer \
  -H "Content-Type: application/json" \
  -d "{\"answer\": \"{answer}\", \"rationale\": \"{rationale}\"}"
```

---

## Step 4 — Route in batch

Build the final assignments from the confirmed plan and execute using the Bash tool:
```
curl -s -X POST http://44.200.186.86/reasoning/api/questions/route-batch \
  -H "Content-Type: application/json" \
  -d '{
    "assignments": [
      {"question_id": "{id}", "reviewer_slack_id": "{slack_id}", "reviewer_name": "{name}"}
    ],
    "developer_slack_id": "U0B2TFPCRBN"
  }'
```

Each reviewer receives one grouped Slack message with Answer buttons.

---

## Step 5 — Summary

Show the user a clean summary:
- ✅ Routed to Slack: each reviewer and how many questions
- ✅ Answered locally: each question and the answer given
- ⏭ Skipped: any skipped questions

Tell the user: once all Slack reviewers have answered, run `/decide-log {prompt_id}` to commit the final decisions to this repo.
