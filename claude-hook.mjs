#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook — reasoning-layer enrichment.
 *
 * Before every Claude Code prompt, this script calls the reasoning-layer
 * backend to find past architectural decisions relevant to the prompt text
 * and injects them as additionalContext so Claude already knows your choices.
 *
 * If the backend is unreachable or returns no decisions, it exits silently
 * and lets the prompt through unmodified.
 */

const BACKEND = "http://44.200.186.86/reasoning";
const TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function main() {
  const raw = await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (buf += chunk));
    process.stdin.on("end", () => resolve(buf));
  });

  let prompt = "";
  try {
    const input = JSON.parse(raw);
    prompt = input.prompt ?? "";
  } catch {
    process.exit(0);
  }

  if (!prompt.trim()) process.exit(0);

  try {
    // 1. Create a prompt record
    const createRes = await fetchWithTimeout(`${BACKEND}/api/prompts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: prompt }),
    });
    if (!createRes.ok) process.exit(0);
    const { prompt_id } = await createRes.json();

    // 2. Fetch enriched version (uses semantic search if OpenAI key is set,
    //    otherwise falls back to most-recent decisions)
    const enrichRes = await fetchWithTimeout(
      `${BACKEND}/api/prompts/${prompt_id}/enriched`
    );
    if (!enrichRes.ok) process.exit(0);
    const { relevant_decisions, mode, decisions_injected } =
      await enrichRes.json();

    if (!relevant_decisions?.length) process.exit(0);

    // 3. Build the context block injected before Claude sees the prompt
    const lines = [
      `## Relevant past architectural decisions (${mode} mode, ${decisions_injected} found)`,
      "",
      ...relevant_decisions.map((d, i) => [
        `### Decision ${i + 1}`,
        `**Q:** ${d.question_text}`,
        `**A:** ${d.answer}`,
        d.rationale ? `**Rationale:** ${d.rationale}` : null,
        "",
      ].filter(Boolean).join("\n")),
      "---",
      "Use the decisions above as established context. Do not re-litigate them unless the user explicitly asks.",
    ];

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: lines.join("\n"),
        },
      })
    );
  } catch {
    // Backend down or timeout — let the prompt through unmodified
    process.exit(0);
  }
}

main();
