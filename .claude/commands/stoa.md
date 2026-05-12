# /stoa command dispatcher (v0.3.0 BETA)

> Operator typed: `/stoa $ARGUMENTS`
>
> Parse the first word of `$ARGUMENTS` as the subcommand. If empty, default to `help`.

## Active subcommands

### `help` (default)

Print:

```
[stoa v0.3.0 BETA] Stoa command surface

  /stoa help               This message
  /stoa init               Scan repo, propose tracking artifacts en masse
  /stoa track <path>       Track a specific file for coherence
  /stoa status             Show install + tracked artifacts state
  /stoa audit              Cross-cutting drift + session-reflective sweeps on demand

Workflow commands (ship post-v0.1, currently stubs):
  /stoa ask @<handle> <q>      Cross-laptop handoff (Slack)
  /stoa respond <id>           Respond to inbound /stoa ask
  /stoa publish-doc <path>     Push markdown to GDoc
  /stoa fetch-comments <path>  Pull comments back
  /stoa triage-comments <path> Walk through fetched comments
  /stoa request-review <path>  Author-initiated review request
  /stoa announce-plan <wal-id> Broadcast phased-plan WAL entry

Starting paths for new operators:
  1. Run `/stoa init` to scan for trackable artifacts.
  2. Or just start working — Stoa proposes [stoa] suggestions
     when it sees substantial new artifacts.

To disable Stoa: remove the @stoa.md line from CLAUDE.md
(or the stoa.md pointer from AGENTS.md on Codex). No subcommand needed.

All subcommands are also prose-invokable. e.g. "scan for artifacts" → /stoa init.

For depth: see proposed_methodology.md and getting_started.md in the source repo.
```

### `init`

Walk the repo for substantial human-maintained artifacts.

**Skip:**
- `.git/`, `node_modules/`, `vendor/`, `dist/`, `build/`, anything in `.gitignore`
- Files matching `*.generated.*`, `auto-*`, `*-autogen*`
- Files with header markers: `<!-- AUTO-GENERATED -->`, `<!-- DO NOT EDIT -->`, YAML frontmatter `generated: true`
- Files already listed in `.stoa/artifacts.md` (re-runs are incremental)
- Paths the operator has previously declined for tracking (look for prior `decision` entries in `context_log.md` flagging "decline-track <path>")

**Mode:** ask operator at start: `[a]ll / [n]one / [i]nteractive`. Default `[i]nteractive` (per-file accept/decline).

For accepted items: ask the operator for a 1-2 line role description in their prose (or propose one based on file content; operator approves/edits). Append to `.stoa/artifacts.md`. After the run, log a single `decision` WAL entry in `context_log.md` summarizing what was added (paths + role descriptions).

For declined-with-reason items: log a `decision` WAL entry rationalizing the skip (so future `/stoa init` re-runs honor it).

### `track <path>`

Operator-initiated single-file tracking. Append to `.stoa/artifacts.md` after asking for the role description. Log a `decision` WAL entry.

### `status`

Read:
- `.stoa/installed` → version + install timestamp + stoa-md-hash
- `.stoa/artifacts.md` → count of tracked entries
- `CLAUDE.md` (Claude Code) or `AGENTS.md` (Codex) → confirm the stoa.md import/pointer is still present.

Report:

```
[stoa v0.3.0 BETA] status
  Installed:  v0.3.0 at 2026-05-11T... (stoa-md-hash: <hash>; hook-script-hash: <hash>)
  Loaded via: @stoa.md in CLAUDE.md (or pointer in AGENTS.md on Codex)
  Tracked:    N artifacts in .stoa/artifacts.md
  Source:     <canonical-source-url>
```

If `.stoa/installed` is missing, surface the broken-state warning (per the pre-flight check in `stoa.md`).

If the import/pointer is missing in CLAUDE.md/AGENTS.md but `.stoa/installed` exists, surface: *"Stoa is installed but not loaded — the `@stoa.md` import is missing from CLAUDE.md. Add it back to re-enable Stoa for your sessions."*

### `audit`

Two complementary sweeps on operator demand. AI-judgment-based; no strict-schema validator.

#### Cross-cutting drift sweep

**What to check:**
- **Terminology drift**: references to deprecated concepts, renamed primitives, prior-shape language that's been superseded.
- **Slash-command namespace**: bare slash commands that should be under `/stoa <subcommand>`; old single-token forms (`/stoa-orient`) that should be subcommand form (`/stoa orient`).
- **URL placeholders**: any `<placeholder-style>` URL that should have been resolved.
- **Section anchors**: markdown links pointing at headings; verify the anchor target exists.
- **Version-stamp consistency**: calendar version (e.g., `2026-05`), adoption-package version (e.g., `v0.3.0 BETA`).
- **Stale references to deprecated files**: files marked DEPRECATED in their headers; references to them in active docs should be the redirect target instead.
- **Propagation lag**: scan recent `decision`-type WAL entries (last ~10) for known supersession relationships; check whether documented changes actually propagated across tracked artifacts.

**How:**
1. Read `.stoa/artifacts.md` to know what's tracked.
2. Read recent `decision` entries from `context_log.md` for supersession context.
3. Use grep + read across the tracked-artifact list (judiciously beyond if useful).
4. Surface a structured report: `Clean` (verified categories), `Issues found` (with file:line), `Operator-space items` (working notes / scratch sections — flagged but not auto-fixed).
5. Ask the operator: apply fixes? If yes, apply them, then propose appending an `observation` WAL entry to `context_log.md` recording the audit (paths checked, fixes applied, items left as-is).

#### Session-reflective sweep

Reflects on the current session's conduct against Stoa's rules; surfaces candidate `beta_tracker.md` entries.

**What to check:**
- **Initialization compliance**: pre-flight check ran (`.stoa/installed` read; version match verified; hook-activation status checked); session-start banner printed.
- **WAL management discipline**: settling cues fired on operator phrases that should have triggered a self-check; phase-settlement trigger fired before implementation-start offers; cadence #3 ran before commits; cadence #4 ran before `/compact` or `/clear`.
- **Cadence-fire compliance**: drift walks (#1) ran on commits; propagation passes (#2) ran after `decision`-type WAL entries.

**How:**
1. Read the current session's conversation history (AI's own context).
2. For each rule above, identify moments where the rule should have fired and whether it did.
3. Surface each miss as a bold `[stoa]` one-liner with a proposed `beta_tracker.md` entry headline.
4. Operator confirms yes/no per candidate.
5. For confirmed candidates: append entries to `.stoa/beta_tracker.md` using the four-field format (headline, what happened, agent self-reflection, proposed Stoa fix, status=`open`).

**Scope-limit:** reflects on AI's current session context only. Decisions/actions pre-compact/clear are out of scope (lost with the context). For pre-compact/clear miss detection, cadence #4 fires at compact-time.

**Discipline (both sweeps):**
- Never auto-fix or auto-write without operator confirmation. Cross-cutting sweep proposes file fixes + an `observation` WAL entry; session-reflective sweep proposes `beta_tracker.md` candidates.
- Skip historical WAL entries (append-only — they reference whatever language was current at write time).
- Skip operator-marked scratch sections (e.g., headed `Working notes` with explicit *"delete before sharing"* / *"iteration scratch"*).
- Use AI judgment for *"is this a real inconsistency or a deliberate exception?"* — when uncertain, surface as a question, not a fix.
- AI is meta-blind to its own failure modes; operator-in-loop on the session-reflective sweep preserves entry-quality.

## Stub subcommands (v0.1)

For `ask`, `respond`, `publish-doc`, `fetch-comments`, `triage-comments`, `request-review`, `announce-plan` — surface:

```
[stoa v0.3.0 BETA] /stoa <subcommand> ships post-v0.1.

This integration is part of the Slack/Jira/GDocs adapter spec, coming
after the beta retrospective. For now, use your existing channel for
this kind of work — when the integration ships, the prose-equivalent
intent will route to the active command automatically.

Track follow-up at: https://github.com/RelationalAI/stoa-ai/blob/main/proposed_methodology.md
   §"What's not yet specified" → "Slack adapter spec" / "Jira adapter spec".
```

## Unknown subcommand

Surface: `Unknown subcommand. Try /stoa help.`
