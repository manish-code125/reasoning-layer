import type { PromptAnalysis } from "../types.js";

// ---------------------------------------------------------------------------
// CLASSIFIER — produces structured JSON analysis of a developer prompt
// Model: claude-haiku-4-5-20251001 (fast, cheap, excellent at structured JSON extraction)
// ---------------------------------------------------------------------------

export const CLASSIFIER_SYSTEM = `You are an architectural risk classifier for software engineering tasks.
Given a developer prompt and optional repo context, analyze the engineering implications.
Respond with valid JSON only — no markdown code fences, no explanation, no prose. Raw JSON object.`;

export function buildClassifierPrompt(params: {
  content: string;
  repoPath?: string | null;
  openFilePath?: string | null;
  language?: string | null;
  readmeSnippet?: string | null;
}): string {
  const ctxLines = [
    params.language && `Language: ${params.language}`,
    params.openFilePath && `Current file: ${params.openFilePath}`,
    params.repoPath && `Repo path: ${params.repoPath}`,
    params.readmeSnippet &&
      `README excerpt:\n${params.readmeSnippet.slice(0, 600)}`,
  ]
    .filter(Boolean)
    .join("\n");

  return `Developer prompt:
<prompt>
${params.content}
</prompt>

${ctxLines ? `Context:\n${ctxLines}\n\n` : ""}Output this exact JSON structure. No other text:
{
  "domain": "<primary domain: auth | billing | data-pipeline | api | infra | search | notifications | messaging | storage | analytics | etc.>",
  "risk_level": "<low | medium | high | critical>",
  "architectural_impact": "<none | low | medium | high>",
  "product_ambiguity": "<none | low | medium | high>",
  "surfaced_concerns": ["<pick from: async, retries, audit, scalability, infra, compliance, multi-tenancy, data-model, security, latency, cost, consistency, idempotency, observability>"]
}

Risk level rubric:
- low: clear scope, contained change, easily reversible, no cross-system effects
- medium: touches multiple components, has non-obvious constraints, or affects shared state
- high: touches data model, auth, billing, cross-team contracts, or significant scale implications
- critical: security-critical, regulatory or financial exposure, or decisions that are hard to reverse at scale`;
}

// ---------------------------------------------------------------------------
// QUESTION GENERATOR — produces targeted clarification questions
// Model: claude-sonnet-4-6 (better reasoning on subtle architectural tradeoffs)
// ---------------------------------------------------------------------------

export const QUESTION_SYSTEM = `You are an experienced software architect reviewing a development task before any code is written.
Your job is to surface ambiguities that, if left unresolved, would force rework or architectural changes later.
Generate questions that a developer cannot answer alone — they require PM, tech lead, or architect input.

For each question, also set "suggested_entry_type" to signal the most likely nature of the answer:
- "decision"     — a positive answer that settles a direction (the default)
- "wont_do"      — the answer will almost certainly be an explicit rejection or scope cut
- "table"        — the concern is valid but clearly belongs in a later phase
- "branch"       — the question reveals it should be decomposed into multiple sub-questions
- "observation"  — a constraint the team should note, but no active decision is required

Respond with a valid JSON array only — no markdown, no explanation, no prose. Raw JSON array.`;

export function buildQuestionPrompt(params: {
  content: string;
  analysis: PromptAnalysis;
  count: number;
}): string {
  const { content, analysis, count } = params;

  return `Developer prompt:
<prompt>
${content}
</prompt>

Analysis:
- Domain: ${analysis.domain}
- Risk level: ${analysis.risk_level}
- Architectural impact: ${analysis.architectural_impact}
- Product ambiguity: ${analysis.product_ambiguity}
- Surfaced concerns: ${analysis.surfaced_concerns.join(", ") || "none identified"}

Generate exactly ${count} clarification questions. Each question must:
1. Be answerable in 1-2 sentences by a domain expert
2. Surface a decision that, if wrong, causes rework or architectural drift
3. Require PM, tech lead, or architect input — not just developer judgement
4. Map clearly to one of the surfaced concerns or reveal a hidden one

For each question, output:
- "text": the question itself — specific and concrete, not generic
- "category": "architectural" | "product" | "infra" | "compliance" | "ux"
- "risk_level": "low" | "medium" | "high" | "critical"
- "should_escalate": true if risk_level is high or critical AND the developer cannot resolve it without stakeholder input
- "suggested_entry_type": "decision" | "wont_do" | "table" | "branch" | "observation"

Worked example for "Build a multi-tenant billing reconciliation service":
[
  {"text":"Should reconciliation run in real-time or as a periodic batch job?","category":"architectural","risk_level":"high","should_escalate":true,"suggested_entry_type":"decision"},
  {"text":"What is the authoritative source of truth for billing amounts — our DB or the payment processor's ledger?","category":"product","risk_level":"high","should_escalate":true,"suggested_entry_type":"decision"},
  {"text":"Are partial approvals (e.g. partial refunds) in scope for the reconciliation flow?","category":"product","risk_level":"medium","should_escalate":true,"suggested_entry_type":"wont_do"},
  {"text":"Is a full audit trail required for every reconciliation event, or only for discrepancies?","category":"compliance","risk_level":"high","should_escalate":true,"suggested_entry_type":"decision"},
  {"text":"Should we support multiple currencies with point-in-time exchange rate snapshots in v1?","category":"product","risk_level":"medium","should_escalate":false,"suggested_entry_type":"table"}
]

Generate ${count} questions for the prompt above. Output JSON array only:`;
}
