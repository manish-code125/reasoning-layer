// Conflict detection between architectural decisions.
// Uses Claude Haiku to identify when a new decision contradicts existing ones,
// or when a batch of decisions contradict each other (for catch-up cadence).
// Falls back to returning no conflicts if ANTHROPIC_API_KEY is not set.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.QUESTION_MODEL ?? "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
if (process.env.ANTHROPIC_API_KEY) {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export function conflictDetectionAvailable(): boolean {
  return client !== null;
}

export type ConflictCandidate = {
  decision_id: string;
  hex_id: string;
  question_text: string;
  answer: string;
  rationale: string | null;
  created_at: string;
};

export type ConflictResult = ConflictCandidate & { reason: string };

function stripFences(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

// Check a single new decision against a list of candidates.
// Returns only entries from `candidates` that contradict `decision`.
export async function detectConflicts(params: {
  decision: { question_text: string; answer: string };
  candidates: ConflictCandidate[];
}): Promise<ConflictResult[]> {
  if (!client || params.candidates.length === 0) return [];

  const { decision, candidates } = params;

  const decisionList = candidates
    .map((c, i) => `[${i}] Q: ${c.question_text}\n    A: ${c.answer}`)
    .join("\n\n");

  const prompt = `You are checking whether an architectural decision contradicts any existing decisions.

New decision:
Q: ${decision.question_text}
A: ${decision.answer}

Existing decisions (0-indexed):
${decisionList}

Identify which existing decisions CONTRADICT the new one — meaning they give an opposite or incompatible answer to the same underlying question.
Ignore decisions about clearly different topics.

Return ONLY a JSON array. Each entry: { "index": <number>, "reason": "<one sentence explaining the contradiction>" }
Empty array [] if none contradict. No explanation outside the JSON.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
    const parsed: Array<{ index: number; reason: string }> = JSON.parse(stripFences(raw));

    return parsed
      .filter((r) => r.index >= 0 && r.index < candidates.length)
      .map((r) => ({ ...candidates[r.index], reason: r.reason }));
  } catch {
    return [];
  }
}

// Check N decisions against each other for contradicting pairs.
// Used by the catch-up cadence to detect cross-developer conflicts in a window.
export async function detectConflictsBatch(
  decisions: ConflictCandidate[]
): Promise<{ hex_a: string; hex_b: string; reason: string }[]> {
  if (!client || decisions.length < 2) return [];

  const decisionList = decisions
    .map((d, i) => `[${i}] Q: ${d.question_text}\n    A: ${d.answer}`)
    .join("\n\n");

  const prompt = `You are reviewing a set of architectural decisions to identify contradictions.

Decisions (0-indexed):
${decisionList}

Identify any pairs of decisions that directly contradict each other — opposite or incompatible answers to the same underlying question.
Ignore pairs about clearly different topics.

Return ONLY a JSON array. Each entry: { "a": <index>, "b": <index>, "reason": "<one sentence>" }
Empty array [] if no contradictions. No explanation outside the JSON.`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    });

    const raw = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
    const parsed: Array<{ a: number; b: number; reason: string }> = JSON.parse(stripFences(raw));

    return parsed
      .filter((r) => r.a >= 0 && r.a < decisions.length && r.b >= 0 && r.b < decisions.length && r.a !== r.b)
      .map((r) => ({
        hex_a: decisions[r.a].hex_id,
        hex_b: decisions[r.b].hex_id,
        reason: r.reason,
      }));
  } catch {
    return [];
  }
}
