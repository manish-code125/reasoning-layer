import * as vscode from "vscode";
import { apiGet, apiPost, repoPath } from "../api/client";

interface Decision {
  decision_id: string;
  decision_number: number;
  hex_id: string;
  entry_type: string;
  question_text: string;
  answer: string;
  rationale: string | null;
  alternatives_considered: string | null;
  reopen_condition: string | null;
  supersedes_id: string | null;
  reviewer_slack_id: string | null;
  linked_files: string[];
  created_at: string;
}

const ENTRY_TYPE_LABELS: Record<string, string> = {
  decision: "✅ Decision",
  wont_do: "🚫 Won't Do",
  table: "🅿 Tabled",
  branch: "🌿 Branch",
  rollback: "↩ Rollback",
  observation: "👁 Observation",
};

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) nonce += chars[Math.floor(Math.random() * chars.length)];
  return nonce;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decisionCard(d: Decision): string {
  const date = d.created_at?.slice(0, 10) ?? "";
  const num = String(d.decision_number).padStart(3, "0");
  const typeLabel = ENTRY_TYPE_LABELS[d.entry_type] ?? d.entry_type;
  const hexRef = d.hex_id ? ` <span class="hex-id">${escapeHtml(d.hex_id)}</span>` : "";
  const canSupersede = d.entry_type === "decision" || d.entry_type === "wont_do";
  const supersedeBtn = canSupersede
    ? `<button class="supersede-btn" onclick="supersede('${d.decision_id}','${escapeHtml(d.question_text.replace(/'/g, "\\'"))}')">↩ Supersede</button>`
    : "";
  return `
<div class="card entry-${escapeHtml(d.entry_type)}">
  <div class="card-header">
    <span class="adr-num">ADR-${num}</span>
    <span class="type-badge">${typeLabel}${hexRef}</span>
    <span class="date">${date}</span>
    ${supersedeBtn}
  </div>
  <div class="question">${escapeHtml(d.question_text)}</div>
  <div class="answer">${escapeHtml(d.answer)}</div>
  ${d.rationale ? `<div class="rationale"><span class="label">Rationale:</span> ${escapeHtml(d.rationale)}</div>` : ""}
  ${d.alternatives_considered ? `<div class="alternatives"><span class="label">Alternatives:</span> ${escapeHtml(d.alternatives_considered)}</div>` : ""}
  ${d.reopen_condition ? `<div class="reopen"><span class="label">Revisit if:</span> ${escapeHtml(d.reopen_condition)}</div>` : ""}
  ${d.supersedes_id ? `<div class="supersedes"><span class="label">Supersedes:</span> <code>${escapeHtml(d.supersedes_id)}</code></div>` : ""}
</div>`;
}

export class DecisionPanel {
  public static currentPanel: DecisionPanel | undefined;
  private static readonly viewType = "reasoningLayerDecisions";

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.onDidChangeViewState(
      () => { if (this._panel.visible) this._update(); },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      async (msg: { command: string; decisionId?: string; questionText?: string }) => {
        if (msg.command === "refresh") await this._update();
        if (msg.command === "syncLog") {
          await vscode.commands.executeCommand("reasoning-layer.syncLog");
          await this._update();
        }
        if (msg.command === "supersede" && msg.decisionId) {
          await this._supersedeDecision(msg.decisionId, msg.questionText ?? "");
        }
      },
      null,
      this._disposables
    );
  }

  public static createOrShow(extensionUri: vscode.Uri): void {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (DecisionPanel.currentPanel) {
      DecisionPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      DecisionPanel.viewType,
      "Decisions",
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    DecisionPanel.currentPanel = new DecisionPanel(panel, extensionUri);
  }

  public dispose(): void {
    DecisionPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) d.dispose();
    }
  }

  private async _update(): Promise<void> {
    this._panel.webview.html = this._shellHtml("Loading decisions...", true);

    let decisions: Decision[] = [];
    try {
      const repo = repoPath();
      const qs = repo ? `?repo=${encodeURIComponent(repo)}&limit=50` : "?limit=50";
      decisions = await apiGet<Decision[]>(`/api/decisions${qs}`);
    } catch (err) {
      this._panel.webview.html = this._shellHtml(
        `<div class="error">Error: ${escapeHtml(err instanceof Error ? err.message : String(err))}</div>`,
        false
      );
      return;
    }

    const nonce = getNonce();
    const cssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "media", "panel.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${cssUri}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    const body =
      decisions.length === 0
        ? `<p class="empty">No decisions recorded yet. Analyze a prompt to get started.</p>`
        : decisions.map(decisionCard).join("");

    this._panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <div class="toolbar">
    <span class="count">${decisions.length} decision${decisions.length === 1 ? "" : "s"}</span>
    <div class="actions">
      <button onclick="sync()">Sync to Git</button>
      <button onclick="refresh()">Refresh</button>
    </div>
  </div>
  <div id="decisions">${body}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    function refresh() { vscode.postMessage({ command: 'refresh' }); }
    function sync() { vscode.postMessage({ command: 'syncLog' }); }
    function supersede(decisionId, questionText) {
      vscode.postMessage({ command: 'supersede', decisionId, questionText });
    }
  </script>
</body>
</html>`;
  }

  private async _supersedeDecision(supersededId: string, questionText: string): Promise<void> {
    const answer = await vscode.window.showInputBox({
      title: "Supersede Decision",
      prompt: `What replaces this decision?\n"${questionText}"`,
      placeHolder: "The new settled answer…",
      ignoreFocusOut: true,
    });
    if (!answer?.trim()) return;

    const rationale = await vscode.window.showInputBox({
      title: "Rationale (optional)",
      prompt: "Why is this decision being changed?",
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
        question_text: questionText,
        answer: answer.trim(),
        entry_type: "rollback",
        rationale: rationale?.trim() || undefined,
        alternatives_considered: alternatives?.trim() || undefined,
        supersedes_id: supersededId,
        linked_repo: repoPath() || undefined,
      });
      vscode.window.showInformationMessage("Rollback entry saved — original decision superseded.");
      await this._update();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to save rollback: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // Minimal shell used for loading/error states (no stylesheet needed)
  private _shellHtml(content: string, loading: boolean): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}';`;
    const style = `
      body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }
      .error { color: var(--vscode-errorForeground); }
    `;
    return `<!DOCTYPE html><html lang="en"><head>
      <meta charset="UTF-8">
      <meta http-equiv="Content-Security-Policy" content="${csp}">
      <style nonce="${nonce}">${style}</style>
    </head><body><p>${loading ? content : ""}</p>${loading ? "" : content}</body></html>`;
  }
}
