import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { apiPost, apiGet, developerSlackId, repoPath, openFilePath } from "./api/client";
import { DecisionPanel } from "./panels/DecisionPanel";
import { syncLog } from "./commands/syncLog";
import { AGENT_FILE_TEMPLATE, AGENT_FILE_VERSION } from "./templates/agentFile";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PromptCreated {
  prompt_id: string;
}

interface AnalyzeResult {
  analysis: { risk_level: string; domain: string };
  questions: Array<{
    text: string;
    category: string;
    risk_level: string;
    should_escalate: boolean;
  }>;
}

interface PromptDetail {
  prompt_id: string;
  questions: Array<{ question_id: string; text: string; risk_level: string; status: string }>;
}

interface PendingQuestion {
  question_id: string;
  text: string;
  category: string | null;
  risk_level: string;
  status: string;
  slack_routed: boolean;
  decision: { answer: string; rationale: string | null } | null;
}

interface EnrichedResult {
  enriched_prompt: string;
  mode: string;
  decisions_injected: number | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RISK: Record<string, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

function selectedText(): string | undefined {
  const e = vscode.window.activeTextEditor;
  if (!e || e.selection.isEmpty) return undefined;
  return e.document.getText(e.selection);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function analyzePrompt(): Promise<void> {
  let text = selectedText();
  if (!text) {
    text = await vscode.window.showInputBox({
      prompt: "Describe the feature or change to analyze",
      placeHolder: "Implement usage-based billing with Redis session storage...",
      ignoreFocusOut: true,
    });
  }
  if (!text?.trim()) return;

  let promptId = "";
  let analyzed!: AnalyzeResult;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reasoning Layer",
        cancellable: false,
      },
      async (p) => {
        p.report({ message: "Submitting prompt..." });
        const created = await apiPost<PromptCreated>("/api/prompts", {
          content: text,
          repo_path: repoPath(),
          open_file_path: openFilePath(),
        });
        promptId = created.prompt_id;

        p.report({ message: "Classifying risk + generating questions..." });
        analyzed = await apiPost<AnalyzeResult>(`/api/prompts/${promptId}/analyze`, {});
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const items = analyzed.questions.map((q) => ({
    label: `${RISK[q.risk_level] ?? "⚪"} ${q.text}`,
    description: `${q.category} · ${q.risk_level}`,
    detail: q.should_escalate ? "⚡ Escalation recommended" : undefined,
    q,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${analyzed.questions.length} questions · risk: ${analyzed.analysis.risk_level} · domain: ${analyzed.analysis.domain}`,
    placeHolder: "Select questions to route to Slack, or press Escape to skip",
    canPickMany: true,
  });

  if (!picked?.length) return;

  let routed = 0;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Routing to Slack",
        cancellable: false,
      },
      async (p) => {
        const detail = await apiGet<PromptDetail>(`/api/prompts/${promptId}`);
        for (const item of picked) {
          const dbQ = detail.questions.find((q) => q.text === item.q.text);
          if (!dbQ) continue;
          p.report({ message: `Posting question ${routed + 1}/${picked.length}...` });
          await apiPost(`/api/questions/${dbQ.question_id}/route`, {
            developer_slack_id: developerSlackId() || undefined,
          });
          routed++;
        }
      }
    );
    vscode.window.showInformationMessage(`Routed ${routed} question(s) to Slack.`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Slack routing failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function listPending(): Promise<void> {
  let questions: PendingQuestion[];
  try {
    const all = await apiGet<PendingQuestion[]>("/api/questions?limit=100");
    questions = all.filter((q) => q.status === "unanswered" || q.status === "routed");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!questions.length) {
    vscode.window.showInformationMessage("No pending questions — all caught up!");
    return;
  }

  const items = questions.map((q) => ({
    label: `${RISK[q.risk_level] ?? "⚪"} ${q.text}`,
    description: q.slack_routed ? "📤 In Slack" : "⏳ Local only",
    detail: q.decision ? `✅ ${q.decision.answer.slice(0, 120)}` : undefined,
    q,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${questions.length} pending question(s)`,
    placeHolder: "Select a question to answer locally",
  });

  if (!picked) return;

  if (picked.q.decision) {
    await vscode.window.showInformationMessage(`Answer: ${picked.q.decision.answer}`, { modal: true });
    return;
  }

  const answer = await vscode.window.showInputBox({
    prompt: picked.q.text,
    placeHolder: "Your decision...",
    ignoreFocusOut: true,
  });
  if (!answer?.trim()) return;

  const rationale = await vscode.window.showInputBox({
    prompt: "Rationale (optional)",
    placeHolder: "Why this decision was made...",
    ignoreFocusOut: true,
  });

  try {
    await apiPost(`/api/questions/${picked.q.question_id}/answer`, {
      answer,
      rationale: rationale || undefined,
    });
    vscode.window.showInformationMessage("Answer saved to decision memory.");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to save answer: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function supersedeDecision(): Promise<void> {
  let decisions: Array<{ decision_id: string; decision_number: number; hex_id: string; entry_type: string; question_text: string; answer: string }>;
  try {
    const repo = repoPath();
    const qs = repo ? `?repo=${encodeURIComponent(repo)}&limit=100` : "?limit=100";
    const all = await apiGet<typeof decisions>(`/api/decisions${qs}`);
    // Only allow superseding decision and wont_do entries (others don't make sense to rollback)
    decisions = all.filter((d) => d.entry_type === "decision" || d.entry_type === "wont_do");
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!decisions.length) {
    vscode.window.showInformationMessage("No decisions to supersede yet.");
    return;
  }

  const TYPE_ICON: Record<string, string> = { decision: "✅", wont_do: "🚫" };

  const picked = await vscode.window.showQuickPick(
    decisions.map((d) => ({
      label: `${TYPE_ICON[d.entry_type] ?? "•"} ADR-${String(d.decision_number).padStart(3, "0")} · ${d.hex_id}`,
      description: d.question_text,
      detail: d.answer.slice(0, 100),
      d,
    })),
    { title: "Select decision to supersede", placeHolder: "Pick the entry you want to roll back" }
  );
  if (!picked) return;

  const answer = await vscode.window.showInputBox({
    title: "New decision",
    prompt: `What replaces: "${picked.d.question_text}"`,
    placeHolder: "The new settled answer…",
    ignoreFocusOut: true,
  });
  if (!answer?.trim()) return;

  const rationale = await vscode.window.showInputBox({
    title: "Rationale (optional)",
    prompt: "Why is this being changed?",
    placeHolder: "Context changed, new requirements, discovered constraint…",
    ignoreFocusOut: true,
  });

  const alternatives = await vscode.window.showInputBox({
    title: "Alternatives considered (optional)",
    prompt: "What other options were weighed?",
    ignoreFocusOut: true,
  });

  try {
    await apiPost("/api/decisions", {
      question_text: picked.d.question_text,
      answer: answer.trim(),
      entry_type: "rollback",
      rationale: rationale?.trim() || undefined,
      alternatives_considered: alternatives?.trim() || undefined,
      supersedes_id: picked.d.decision_id,
      linked_repo: repoPath() || undefined,
    });
    vscode.window.showInformationMessage(
      `Rollback entry saved — ADR-${String(picked.d.decision_number).padStart(3, "0")} superseded.`
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to save rollback: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function enrichContext(): Promise<void> {
  let text = selectedText();
  if (!text) {
    text = await vscode.window.showInputBox({
      prompt: "Enter the task you want context for",
      placeHolder: "Refactor billing reconciliation to support multiple currencies...",
      ignoreFocusOut: true,
    });
  }
  if (!text?.trim()) return;

  let enrichedPrompt = "";
  let mode = "";
  let count = 0;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reasoning Layer",
        cancellable: false,
      },
      async (p) => {
        p.report({ message: "Submitting prompt..." });
        const { prompt_id } = await apiPost<PromptCreated>("/api/prompts", {
          content: text,
          repo_path: repoPath(),
          open_file_path: openFilePath(),
        });

        p.report({ message: "Searching decision memory..." });
        const result = await apiGet<EnrichedResult>(`/api/prompts/${prompt_id}/enriched`);
        enrichedPrompt = result.enriched_prompt;
        mode = result.mode;
        count = result.decisions_injected ?? 0;
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  const doc = await vscode.workspace.openTextDocument({
    content: enrichedPrompt,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
  vscode.window.showInformationMessage(
    `Injected ${count} past decision(s) [${mode} mode]. Copy this enriched prompt into Claude/Cursor.`
  );
}

// ─── Artifact coherence commands ─────────────────────────────────────────────

const IGNORE_PATTERNS = [
  "**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**",
  "**/out/**", "**/coverage/**", "**/*.generated.*", "**/*.lock", "**/pnpm-lock.yaml",
  "**/package-lock.json", "**/.stoa/**", "**/.claude/**",
];

function gitLastCommitTs(filePath: string, root: string): string | null {
  try {
    const rel = path.relative(root, filePath);
    const out = cp.execSync(`git log --format="%aI" -n 1 -- "${rel}"`, { cwd: root }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

async function getOrCreateRepoId(root: string): Promise<string> {
  const result = await apiPost<{ repo_id?: string; id?: string }>("/api/prompts", {
    content: "__repo_probe__",
    repo_path: root,
  });
  // We only need the repo to be upserted — delete the probe prompt silently
  return result.repo_id ?? "";
}

async function resolveRepoByPath(root: string): Promise<string | null> {
  try {
    // Track a dummy artifact to force repo upsert, then get the repo id via artifacts list
    // Simpler: use the repo path directly as the :id param (artifacts route accepts path or UUID)
    const artifacts = await apiGet<{ artifact_id: string }[]>(
      `/api/repos/${encodeURIComponent(root)}/artifacts`
    );
    return root; // route accepts path as id
  } catch {
    return null;
  }
}

async function initArtifacts(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  // Ask mode upfront
  const mode = await vscode.window.showQuickPick(
    [
      { label: "Interactive", description: "Review each file one by one (recommended)", value: "interactive" },
      { label: "All", description: "Track all candidate files automatically", value: "all" },
      { label: "Cancel", description: "", value: "cancel" },
    ],
    { title: "Reasoning Layer: Init Artifacts", placeHolder: "How do you want to select files to track?" }
  );
  if (!mode || mode.value === "cancel") return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Scanning workspace…", cancellable: false },
    async () => {
      const uris = await vscode.workspace.findFiles("**/*", `{${IGNORE_PATTERNS.join(",")}}`);
      // Keep only files with meaningful extensions
      const candidates = uris
        .filter((u) => /\.(ts|tsx|js|jsx|py|go|rs|java|rb|sql|prisma|md|yaml|yml|json|toml|sh)$/.test(u.fsPath))
        .map((u) => path.relative(root, u.fsPath))
        .slice(0, 100); // cap at 100 for UX

      if (!candidates.length) {
        vscode.window.showInformationMessage("No trackable files found.");
        return;
      }

      const toTrack: Array<{ filePath: string; description: string }> = [];

      if (mode.value === "all") {
        for (const f of candidates) toTrack.push({ filePath: f, description: "" });
      } else {
        // Interactive: show QuickPick with all candidates, let user multi-select
        const picked = await vscode.window.showQuickPick(
          candidates.map((f) => ({ label: f, picked: false })),
          { title: `Select files to track (${candidates.length} candidates)`, canPickMany: true, placeHolder: "Space to select, Enter to confirm" }
        );
        if (!picked?.length) return;

        for (const item of picked) {
          const desc = await vscode.window.showInputBox({
            title: `Role of ${item.label}`,
            placeHolder: "e.g. canonical DB schema, billing service, auth middleware…",
            ignoreFocusOut: true,
          });
          toTrack.push({ filePath: item.label, description: desc?.trim() ?? "" });
        }
      }

      // POST each tracked file to the backend
      let tracked = 0;
      for (const { filePath, description } of toTrack) {
        try {
          await apiPost(`/api/repos/${encodeURIComponent(root)}/artifacts`, {
            file_path: filePath,
            description: description || undefined,
          });
          tracked++;
        } catch { /* skip files that fail */ }
      }

      vscode.window.showInformationMessage(
        `Reasoning Layer: tracked ${tracked} file${tracked !== 1 ? "s" : ""}. Use "Link Decision to Files" after answering questions to connect decisions to these files.`
      );
    }
  );
}

async function trackCurrentFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const editor = vscode.window.activeTextEditor;
  if (!root || !editor) {
    vscode.window.showWarningMessage("Open a file to track it.");
    return;
  }

  const filePath = path.relative(root, editor.document.uri.fsPath);
  const description = await vscode.window.showInputBox({
    title: `Track: ${filePath}`,
    placeHolder: "Describe the role of this file (e.g. canonical DB schema)…",
    ignoreFocusOut: true,
  });
  if (description === undefined) return; // cancelled

  try {
    await apiPost(`/api/repos/${encodeURIComponent(root)}/artifacts`, {
      file_path: filePath,
      description: description.trim() || undefined,
    });
    vscode.window.showInformationMessage(`Reasoning Layer: now tracking ${filePath}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to track file: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkDrift(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  let drifted: Array<{ file_path: string; latest_decision: { hex_id: string; question_text: string; answer: string; created_at: string } }> = [];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Checking artifact drift…", cancellable: false },
    async () => {
      // Build file timestamp map for all tracked artifacts via git
      const artifacts = await apiGet<Array<{ file_path: string }>>(`/api/repos/${encodeURIComponent(root)}/artifacts`);
      if (!artifacts.length) {
        vscode.window.showInformationMessage("No tracked artifacts yet. Run 'Init Artifacts' first.");
        return;
      }

      const fileTimestamps: Record<string, string> = {};
      for (const a of artifacts) {
        const ts = gitLastCommitTs(path.join(root, a.file_path), root);
        if (ts) fileTimestamps[a.file_path] = ts;
      }

      const result = await apiPost<{ drifted: typeof drifted }>(
        `/api/repos/${encodeURIComponent(root)}/artifacts/drift`,
        { file_timestamps: fileTimestamps }
      );
      drifted = result.drifted;
    }
  );

  if (!drifted.length) {
    vscode.window.showInformationMessage("✅ No drift detected — all tracked files are coherent with their decisions.");
    return;
  }

  const items = drifted.map((d) => ({
    label: `⚠ ${d.file_path}`,
    description: `decision \`${d.latest_decision.hex_id}\` is newer`,
    detail: d.latest_decision.question_text,
    d,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: `${drifted.length} drifted file${drifted.length !== 1 ? "s" : ""} — decisions are newer than last commit`,
    placeHolder: "Select a file to see the relevant decision",
  });

  if (picked) {
    const d = picked.d.latest_decision;
    await vscode.window.showInformationMessage(
      `Decision \`${d.hex_id}\` (${d.created_at.slice(0, 10)}): ${d.answer}`,
      { modal: true }
    );
  }
}

async function writeCoherenceHook(root: string): Promise<void> {
  const hookMode = vscode.workspace.getConfiguration("reasoning-layer").get<string>("hookMode") ?? "warn";
  const backendUrl =
    vscode.workspace.getConfiguration("reasoning-layer").get<string>("backendUrl") ??
    "http://44.200.186.86/reasoning";

  const hookDir = path.join(root, ".githooks");
  const hookPath = path.join(hookDir, "pre-commit");

  const hookContent = `#!/usr/bin/env bash
# Reasoning Layer coherence hook — auto-generated, do not edit manually.
# Mode: ${hookMode} — change via VS Code setting reasoning-layer.hookMode

set -euo pipefail

BACKEND="${backendUrl}"
REPO_PATH="$(git rev-parse --show-toplevel)"

# Get staged files
STAGED=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
if [ -z "$STAGED" ]; then
  exit 0
fi

# Build file timestamps and check drift
python3 << 'PYEOF'
import json, subprocess, urllib.request, urllib.error, sys, os

BACKEND = os.environ.get("REASONING_LAYER_BACKEND", "${backendUrl}")
REPO_PATH = subprocess.check_output(["git", "rev-parse", "--show-toplevel"]).decode().strip()
STAGED = subprocess.check_output(["git", "diff", "--cached", "--name-only", "--diff-filter=ACM"]).decode().strip().split("\\n")

file_timestamps = {}
for f in STAGED:
    if not f:
        continue
    try:
        ts = subprocess.check_output(["git", "log", "--format=%aI", "-n", "1", "--", f]).decode().strip()
        if ts:
            file_timestamps[f] = ts
    except Exception:
        pass

if not file_timestamps:
    sys.exit(0)

try:
    body = json.dumps({"file_timestamps": file_timestamps}).encode()
    req = urllib.request.Request(
        BACKEND + "/api/repos/" + urllib.parse.quote(REPO_PATH, safe="") + "/artifacts/drift",
        data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    import urllib.parse
    req = urllib.request.Request(
        BACKEND + "/api/repos/" + urllib.parse.quote(REPO_PATH, safe="") + "/artifacts/drift",
        data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    resp = json.loads(urllib.request.urlopen(req, timeout=5).read())
    drifted = resp.get("drifted", [])
except Exception:
    sys.exit(0)  # network failure — never block a commit

if not drifted:
    sys.exit(0)

print("\\n⚠  Reasoning Layer: decisions exist that may not be reflected in these files:")
for d in drifted:
    dec = d["latest_decision"]
    print(f"  {d['file_path']} ← [{dec['hex_id']}] {dec['question_text']}")
    print(f"    Decision: {dec['answer'][:120]}")
print()
${hookMode === "block"
  ? `print("Commit blocked (hookMode=block). Update the files or create a WAL entry, then retry.")
sys.exit(1)`
  : `print("Continuing commit (hookMode=warn). Run 'Reasoning Layer: Check Drift' in VS Code to review.")
sys.exit(0)`}
PYEOF

# WAL conflict check — runs only when context_log.md is staged
python3 << 'WALEOF'
import json, subprocess, urllib.request, sys, os, re

BACKEND = os.environ.get("REASONING_LAYER_BACKEND", "${backendUrl}")
HOOK_MODE = "${hookMode}"

staged = subprocess.check_output(
    ["git", "diff", "--cached", "--name-only"]
).decode().strip().split("\\n")

if "context_log.md" not in staged:
    sys.exit(0)

diff_text = subprocess.check_output(
    ["git", "diff", "--cached", "--", "context_log.md"]
).decode()

new_hex_ids = re.findall(r'^\\+## \`([a-f0-9]{7,})\`', diff_text, re.MULTILINE)
if not new_hex_ids:
    sys.exit(0)

conflicts_found = []
for hex_id in new_hex_ids:
    try:
        url = f"{BACKEND}/api/decisions/{hex_id}/conflicts"
        result = json.loads(urllib.request.urlopen(url, timeout=8).read())
        for c in result.get("conflicts", []):
            conflicts_found.append({"new_hex": hex_id, "prior": c})
    except Exception:
        pass

if not conflicts_found:
    sys.exit(0)

SEP = "=" * 72
print(f"\\n[Reasoning Layer] WAL Conflict Detected")
print(SEP)

for item in conflicts_found:
    p = item["prior"]
    captured = p.get("created_at", "")[:10]
    print(f"  Your new entry:   [{item['new_hex']}]")
    print(f"  Conflicts with:   [{p['hex_id']}]  (captured {captured})")
    print(f"  Their question:   {p['question_text']}")
    print(f"  Their decision:   {p['answer']}")
    if p.get("rationale"):
        print(f"  Their rationale:  {p['rationale']}")
    print(f"  Why it conflicts: {p['reason']}")
    print()

first_new = conflicts_found[0]["new_hex"]
print(SEP)
print(f"  Decision was captured first — it stands in the WAL.")
print(f"  The WAL is append-only. [{first_new}] stays in the log.")
print(f"  To make [{first_new}] the active decision:")
print("    * Open VS Code -> 'Reasoning Layer: Capture Decision'")
print("    * Set type = decision, supersedes_id = <their hex_id>, add your rationale.")
print("    * This appends an override entry — full trace preserved.\\n")

if HOOK_MODE == "block":
    print("  Commit blocked (hookMode=block). Add an override entry first, then retry.\\n")
    sys.exit(1)
else:
    print("  Proceeding (hookMode=warn). Resolve the conflict when ready.\\n")
    sys.exit(0)
WALEOF
`;

  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });

  // Wire git to use .githooks/
  try {
    cp.execSync("git config core.hooksPath .githooks", { cwd: root });
  } catch {
    vscode.window.showWarningMessage("Could not set core.hooksPath — run: git config core.hooksPath .githooks");
    return;
  }

}

async function generateCoherenceHook(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  const hookMode = vscode.workspace.getConfiguration("reasoning-layer").get<string>("hookMode") ?? "warn";
  await writeCoherenceHook(root);
  vscode.window.showInformationMessage(
    `Coherence hook written to .githooks/pre-commit (mode: ${hookMode}). It will check artifact drift on every commit.`
  );
}

async function captureDecision(): Promise<void> {
  const repo = repoPath();
  if (!repo) {
    vscode.window.showErrorMessage("Reasoning Layer: No workspace folder open.");
    return;
  }

  const questionText = await vscode.window.showInputBox({
    prompt: "What decision was made? (one sentence — the question being settled)",
    placeHolder: "Which database should we use for session storage?",
    ignoreFocusOut: true,
  });
  if (!questionText?.trim()) return;

  const answer = await vscode.window.showInputBox({
    prompt: "What was decided?",
    placeHolder: "Use Redis — lower latency than Postgres for ephemeral session data",
    ignoreFocusOut: true,
  });
  if (!answer?.trim()) return;

  const entryTypePick = await vscode.window.showQuickPick(
    [
      { label: "decision", description: "Settled positive answer (default)" },
      { label: "wont_do", description: "Explicit rejection (not doing this)" },
      { label: "table", description: "Deferred — revisit later" },
      { label: "observation", description: "Constraint note, no action needed" },
    ],
    { title: "Entry type", placeHolder: "Select entry type" }
  );
  if (!entryTypePick) return;

  const rationale = await vscode.window.showInputBox({
    prompt: "Rationale? (optional — press Enter to skip)",
    ignoreFocusOut: true,
  });

  let hexId = "";
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Reasoning Layer", cancellable: false },
      async (p) => {
        p.report({ message: "Capturing decision..." });
        const resp = await apiPost<{
          hex_id: string;
          entry_type: string;
          question_text: string;
          answer: string;
          rationale: string | null;
        }>("/api/decisions", {
          question_text: questionText.trim(),
          answer: answer.trim(),
          entry_type: entryTypePick.label,
          rationale: rationale?.trim() || undefined,
          linked_repo: repo,
        });

        hexId = resp.hex_id;
        const dateStr = new Date().toISOString().slice(0, 10);
        const rationaleLine = resp.rationale ? `\n**Rationale:** ${resp.rationale}` : "";
        const entry =
          `\n## \`${hexId}\` — ${resp.entry_type} — ${dateStr}\n\n` +
          `**Question:** ${resp.question_text}\n\n` +
          `**Decision:** ${resp.answer}${rationaleLine}\n\n---\n`;

        const ctxPath = path.join(repo, "context_log.md");
        if (!fs.existsSync(ctxPath)) {
          fs.writeFileSync(
            ctxPath,
            `# Context Log\n\n> Append-only WAL. Managed by Reasoning Layer.\n\n---\n${entry}`,
            "utf8"
          );
        } else {
          fs.appendFileSync(ctxPath, entry, "utf8");
        }
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  vscode.window.showInformationMessage(
    `Reasoning Layer: Captured [${hexId}] to decision memory and context_log.md.`
  );

  // Best-effort conflict check — never throw, never block
  try {
    const conflictResult = await apiGet<{
      conflicts: Array<{
        decision_id: string;
        hex_id: string;
        question_text: string;
        answer: string;
        rationale: string | null;
        reason: string;
      }>;
      mode: string;
    }>(`/api/decisions/${hexId}/conflicts`);

    const cfls = conflictResult.conflicts;
    if (cfls.length > 0) {
      const c = cfls[0];
      const more = cfls.length > 1 ? ` (+${cfls.length - 1} more)` : "";
      const rationaleNote = c.rationale ? ` Their rationale: ${c.rationale}` : "";
      const choice = await vscode.window.showWarningMessage(
        `Reasoning Layer: Conflict with [${c.hex_id}] — ${c.reason}${more}.${rationaleNote}`,
        "Override (D1 stays)",
        "Route to Slack",
        "Acknowledge"
      );

      if (choice === "Override (D1 stays)") {
        const overrideRationale = await vscode.window.showInputBox({
          prompt: `Why does your decision [${hexId}] override [${c.hex_id}]?`,
          placeHolder: "e.g. New benchmarks showed Postgres handles our session volume; Redis ops cost too high",
          ignoreFocusOut: true,
        });
        await apiPost("/api/decisions", {
          question_text: c.question_text,
          answer: answer?.trim() ?? "",
          entry_type: "decision",
          rationale: overrideRationale?.trim() || `Overrides [${c.hex_id}] — see WAL trace for prior reasoning`,
          supersedes_id: c.decision_id,
          linked_repo: repo,
        });
        vscode.window.showInformationMessage(
          `Reasoning Layer: Override recorded. [${c.hex_id}] stays in the log — full trace preserved.`
        );
      } else if (choice === "Route to Slack") {
        vscode.window.showInformationMessage(
          `Reasoning Layer: Use "Generate Questions for Task" to route this conflict to a Slack reviewer.`
        );
      }
      // "Acknowledge" → developer is aware, no WAL action needed
    }
  } catch {
    // conflict check is best-effort — silently ignore errors
  }
}

// ─── Ambient agent file install ───────────────────────────────────────────────

const CLAUDE_IMPORT_LINE = "@.claude/reasoning-layer.md";
// workspaceState key — persists the user's "Not now" choice per repo
const DECLINED_KEY = "rl.initDeclined";

function agentFilePath(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return null;
  return path.join(folders[0].uri.fsPath, ".claude", "reasoning-layer.md");
}

async function installAgentFile(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) return;

  const root = folders[0].uri.fsPath;
  const claudeDir = path.join(root, ".claude");
  const filePath = path.join(claudeDir, "reasoning-layer.md");
  const claudeMdPath = path.join(root, "CLAUDE.md");

  const backendUrl =
    vscode.workspace.getConfiguration("reasoning-layer").get<string>("backendUrl") ??
    "http://44.200.186.86/reasoning";

  // Always overwrite — spec-owned file, version updates propagate automatically
  const content = AGENT_FILE_TEMPLATE.replace(/\{\{BACKEND_URL\}\}/g, backendUrl);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");

  // Wire the import into CLAUDE.md — create the file if it doesn't exist yet
  if (fs.existsSync(claudeMdPath)) {
    const existing = fs.readFileSync(claudeMdPath, "utf8");
    if (!existing.includes(CLAUDE_IMPORT_LINE)) {
      fs.writeFileSync(claudeMdPath, `${CLAUDE_IMPORT_LINE}\n\n${existing}`, "utf8");
    }
  } else {
    fs.writeFileSync(claudeMdPath, `${CLAUDE_IMPORT_LINE}\n`, "utf8");
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {

  // ── On-open init check ────────────────────────────────────────────────────
  // Runs silently every time a git repo is opened.
  // Three paths:
  //   1. Already initialized → update the file in place (version propagation), no notification.
  //   2. Not initialized + user previously said "Not now" → stay silent.
  //   3. Not initialized + never asked → show one-time notification.
  (async () => {
    const fp = agentFilePath();
    if (!fp) return;

    if (fs.existsSync(fp)) {
      // Already initialized — silently refresh the file so version updates propagate.
      await installAgentFile().catch((err) =>
        console.error("[reasoning-layer] agent file update failed:", err)
      );
      return;
    }

    // Not initialized yet. Check if they declined before.
    const declined = context.workspaceState.get<boolean>(DECLINED_KEY, false);
    if (declined) return;

    // First time in this repo — ask once.
    const choice = await vscode.window.showInformationMessage(
      "Reasoning Layer: Start capturing architectural decisions for this repo?",
      "Initialize",
      "Not now"
    );

    if (choice === "Initialize") {
      await initializeRepo(context);
    } else {
      // Remember the choice so we never ask again in this repo.
      await context.workspaceState.update(DECLINED_KEY, true);
    }
  })();

  // ── Command registrations ─────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("reasoning-layer.analyzePrompt", analyzePrompt),
    vscode.commands.registerCommand("reasoning-layer.listPending", listPending),
    vscode.commands.registerCommand("reasoning-layer.enrichContext", enrichContext),
    vscode.commands.registerCommand("reasoning-layer.supersedeDecision", supersedeDecision),
    vscode.commands.registerCommand("reasoning-layer.initializeRepo", () =>
      initializeRepo(context)
    ),
    vscode.commands.registerCommand("reasoning-layer.viewDecisions", () =>
      DecisionPanel.createOrShow(context.extensionUri)
    ),
    vscode.commands.registerCommand("reasoning-layer.syncLog", syncLog),
    vscode.commands.registerCommand("reasoning-layer.initArtifacts", initArtifacts),
    vscode.commands.registerCommand("reasoning-layer.trackCurrentFile", trackCurrentFile),
    vscode.commands.registerCommand("reasoning-layer.checkDrift", checkDrift),
    vscode.commands.registerCommand("reasoning-layer.generateCoherenceHook", generateCoherenceHook),
    vscode.commands.registerCommand("reasoning-layer.captureDecision", captureDecision)
  );
}

async function initializeRepo(context: vscode.ExtensionContext): Promise<void> {
  try {
    await installAgentFile();
    // Clear any prior "Not now" so the auto-trigger stays consistent with init state.
    await context.workspaceState.update(DECLINED_KEY, false);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // Create context_log.md if it doesn't exist
    if (root) {
      const ctxPath = path.join(root, "context_log.md");
      if (!fs.existsSync(ctxPath)) {
        fs.writeFileSync(
          ctxPath,
          "# Context Log\n\n> Append-only WAL. Managed by Reasoning Layer.\n\n---\n\n",
          "utf8"
        );
      }
    }

    // Silently install the pre-commit coherence hook
    if (root) {
      await writeCoherenceHook(root).catch(() => {});
    }

    const claudeMdPath = root ? path.join(root, "CLAUDE.md") : null;
    const hasClaude = claudeMdPath ? fs.existsSync(claudeMdPath) : false;

    if (hasClaude) {
      const existing = claudeMdPath ? fs.readFileSync(claudeMdPath!, "utf8") : "";
      const alreadyImported = existing.includes(CLAUDE_IMPORT_LINE);
      vscode.window.showInformationMessage(
        alreadyImported
          ? `Reasoning Layer: initialized — agent file, context_log.md, and pre-commit hook ready (v${AGENT_FILE_VERSION}).`
          : `Reasoning Layer: initialized — agent file, context_log.md, and pre-commit hook ready. Add \`${CLAUDE_IMPORT_LINE}\` to your CLAUDE.md to activate.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Reasoning Layer: initialized — agent file, context_log.md, and pre-commit hook ready. ` +
        `Add \`${CLAUDE_IMPORT_LINE}\` to your CLAUDE.md to activate the ambient agent.`
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer init failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function deactivate(): void {}
