import * as vscode from "vscode";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { apiGetText, repoPath } from "../api/client";

const CONTEXT_LOG_ATTR_LINE = "context_log.md merge=union";

const LOG_HEADER =
  "# Decision Log\n\nAppend-only log of architectural decisions. Do not edit past entries.\n\n---\n\n";

export async function syncLog(): Promise<void> {
  const repo = repoPath();
  if (!repo) {
    vscode.window.showErrorMessage("Reasoning Layer: No workspace folder open.");
    return;
  }

  // Find sync cursor from git history
  let since = "1970-01-01T00:00:00Z";
  try {
    const ts = execSync("git log -1 --format=%aI -- decision.log.md", {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    if (ts) since = ts;
  } catch {
    // Not a git repo or git unavailable — fetch everything
  }

  let content = "";
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Reasoning Layer",
        cancellable: false,
      },
      async (p) => {
        p.report({ message: "Fetching new decisions..." });
        content = await apiGetText(
          `/api/decisions/export-since?repo=${encodeURIComponent(repo)}&since=${encodeURIComponent(since)}`
        );
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Reasoning Layer: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  if (!content.trim()) {
    vscode.window.showInformationMessage("Reasoning Layer: No new decisions since the last sync.");
    return;
  }

  const logPath = path.join(repo, "decision.log.md");
  const attrPath = path.join(repo, ".gitattributes");

  if (!fs.existsSync(logPath)) {
    fs.writeFileSync(logPath, LOG_HEADER, "utf8");
  }
  fs.appendFileSync(logPath, content + "\n", "utf8");

  const attrLine = "decision.log.md linguist-generated=true";
  if (!fs.existsSync(attrPath)) {
    fs.writeFileSync(attrPath, attrLine + "\n", "utf8");
  } else {
    const existing = fs.readFileSync(attrPath, "utf8");
    if (!existing.includes("decision.log.md")) {
      fs.appendFileSync(attrPath, "\n" + attrLine + "\n", "utf8");
    }
    if (!existing.includes("context_log.md")) {
      fs.appendFileSync(attrPath, "\n" + CONTEXT_LOG_ATTR_LINE + "\n", "utf8");
    }
  }

  // Sync context_log.md — full replace from the canonical WAL endpoint (best-effort)
  const ctxPath = path.join(repo, "context_log.md");
  try {
    const ctxContent = await apiGetText(
      `/api/repos/${encodeURIComponent(repo)}/context-log?format=narrative`
    );
    if (ctxContent.trim()) {
      fs.writeFileSync(ctxPath, ctxContent, "utf8");
    }
  } catch {
    // backend unreachable or no decisions yet — skip silently
  }

  try {
    execSync("git add decision.log.md .gitattributes context_log.md", { cwd: repo });
    const date = new Date().toISOString().slice(0, 10);
    execSync(`git commit -m "decisions: sync ${date}"`, { cwd: repo });
  } catch (err) {
    vscode.window.showWarningMessage(
      `Reasoning Layer: Decisions written to decision.log.md but git commit failed: ${err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err)}`
    );
    return;
  }

  const count = (content.match(/^### Decision /gm) ?? []).length;
  vscode.window.showInformationMessage(
    `Reasoning Layer: Synced ${count} decision${count === 1 ? "" : "s"} to decision.log.md and committed.`
  );
}
