import * as vscode from "vscode";

export function baseUrl(): string {
  return (
    vscode.workspace
      .getConfiguration("reasoning-layer")
      .get<string>("backendUrl") ?? "http://44.200.186.86/reasoning"
  );
}

export function developerSlackId(): string {
  const cfg = vscode.workspace.getConfiguration("reasoning-layer");
  return (
    cfg.get<string>("developerSlackId") ||
    cfg.get<string>("defaultSlackUserId") ||
    ""
  );
}

export function repoPath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function openFilePath(): string | undefined {
  return vscode.window.activeTextEditor?.document.uri.fsPath;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

// For endpoints that return plain text (e.g. /decisions/export-since)
export async function apiGetText(path: string): Promise<string> {
  const res = await fetch(`${baseUrl()}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.text();
}
