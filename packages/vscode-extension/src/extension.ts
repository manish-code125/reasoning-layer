import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
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
    vscode.commands.registerCommand("reasoning-layer.syncLog", syncLog)
  );
}

async function initializeRepo(context: vscode.ExtensionContext): Promise<void> {
  try {
    await installAgentFile();
    // Clear any prior "Not now" so the auto-trigger stays consistent with init state.
    await context.workspaceState.update(DECLINED_KEY, false);

    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const claudeMdPath = root ? path.join(root, "CLAUDE.md") : null;
    const hasClaude = claudeMdPath ? fs.existsSync(claudeMdPath) : false;

    if (hasClaude) {
      const existing = claudeMdPath ? fs.readFileSync(claudeMdPath!, "utf8") : "";
      const alreadyImported = existing.includes(CLAUDE_IMPORT_LINE);
      vscode.window.showInformationMessage(
        alreadyImported
          ? `Reasoning Layer: ambient agent updated for this repo (v${AGENT_FILE_VERSION}).`
          : `Reasoning Layer: initialized. Claude will intercept tasks in this repo automatically.`
      );
    } else {
      vscode.window.showInformationMessage(
        `Reasoning Layer: wrote .claude/reasoning-layer.md. ` +
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
