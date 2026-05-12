Append any new decisions to decision.log.md in this repo, starting from where the last commit left off.

Run this with no arguments — it figures out the sync point automatically from git.

---

## Step 1 — Find the last sync point

Using the Bash tool, get the timestamp of the last commit to decision.log.md:

```
git log -1 --format=%aI -- decision.log.md 2>/dev/null
```

If the command returns nothing (file has never been committed), use `1970-01-01T00:00:00Z` as the since timestamp.

## Step 2 — Fetch new decisions

Call the backend with the repo path and since timestamp:

```
curl -s "http://44.200.186.86/reasoning/api/decisions/export-since?repo=$(pwd)&since=<since_timestamp>"
```

If the response is empty, tell the user: "No new decisions since the last sync." Stop here.

## Step 3 — Append and commit

If there are new decisions:

If `decision.log.md` does not exist, create the header first:
```
printf '# Decision Log\n\nAppend-only log of architectural decisions. Do not edit past entries.\n\n---\n\n' > decision.log.md
```

Append the new decisions:
```
printf '%s\n' "<decisions_content>" >> decision.log.md
```

Ensure `.gitattributes` suppresses noisy PR diffs:
```
grep -q 'decision.log.md' .gitattributes 2>/dev/null || printf 'decision.log.md linguist-generated=true\n' >> .gitattributes
```

Stage and commit:
```
git add decision.log.md .gitattributes && git commit -m "decisions: sync $(date -u +%Y-%m-%d)"
```

Tell the user how many decisions were appended and that the log is committed.
