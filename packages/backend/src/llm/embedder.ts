// Semantic search via Claude reranking — no embedding vectors needed.
// Fetches all decisions from DB, sends them to Claude with the query,
// and asks Claude to return the most relevant ones in order.
// Falls back to recency ordering if ANTHROPIC_API_KEY is not set.

import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "../db.js";

const MODEL = process.env.QUESTION_MODEL ?? "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;
if (process.env.ANTHROPIC_API_KEY) {
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

export function embeddingAvailable(): boolean {
  return client !== null;
}

// No-op — Claude reranking doesn't need pre-computed embeddings.
export async function embedDecision(_decisionId: string): Promise<void> {
  return;
}

type SimilarDecision = {
  decision_id: string;
  question_text: string;
  answer: string;
  rationale: string | null;
  reviewer_slack_id: string | null;
  linked_repo: string | null;
  linked_files: string[];
  similarity: number;
  created_at: string;
};

export async function findSimilarDecisions(params: {
  text: string;
  repoId?: string;
  repo?: string;
  limit?: number;
}): Promise<{ results: SimilarDecision[]; mode: "semantic" | "recency" }> {
  const limit = params.limit ?? 5;

  // Prefer repoId FK filter; fall back to linkedRepo string for unbackfilled rows
  let whereClause: object | undefined;
  if (params.repoId) {
    whereClause = { OR: [{ repoId: params.repoId }, { linkedRepo: params.repo ?? null }] };
  } else if (params.repo) {
    whereClause = { linkedRepo: params.repo };
  }

  const allDecisions = await prisma.decision.findMany({
    where: whereClause,
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      questionText: true,
      answer: true,
      rationale: true,
      reviewerSlackId: true,
      linkedRepo: true,
      linkedFiles: true,
      createdAt: true,
    },
  });

  if (!allDecisions.length) {
    return { mode: "recency", results: [] };
  }

  if (!client) {
    return {
      mode: "recency",
      results: allDecisions.slice(0, limit).map((r) => ({
        decision_id: r.id,
        question_text: r.questionText,
        answer: r.answer,
        rationale: r.rationale,
        reviewer_slack_id: r.reviewerSlackId,
        linked_repo: r.linkedRepo,
        linked_files: r.linkedFiles,
        similarity: 1.0,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }

  const decisionList = allDecisions
    .map((d, i) => `[${i}] Q: ${d.questionText}\nA: ${d.answer}`)
    .join("\n\n");

  const prompt = `You are ranking past architectural decisions by relevance to a new query.

Query: "${params.text}"

Decisions:
${decisionList}

Return a JSON array of the indices (0-based) of the most relevant decisions, ordered by relevance, maximum ${limit}. Only include decisions that are actually relevant. Return ONLY the JSON array, nothing else. Example: [2, 0, 4]`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 128,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0].type === "text" ? response.content[0].text.trim() : "[]";
    const indices: number[] = JSON.parse(text);

    const results = indices
      .filter((i) => i >= 0 && i < allDecisions.length)
      .slice(0, limit)
      .map((i, rank) => {
        const d = allDecisions[i];
        return {
          decision_id: d.id,
          question_text: d.questionText,
          answer: d.answer,
          rationale: d.rationale,
          reviewer_slack_id: d.reviewerSlackId,
          linked_repo: d.linkedRepo,
          linked_files: d.linkedFiles,
          similarity: 1 - rank * 0.05,
          created_at: d.createdAt.toISOString(),
        };
      });

    return { mode: "semantic", results };
  } catch {
    // Claude call failed — fall back to recency
    return {
      mode: "recency",
      results: allDecisions.slice(0, limit).map((r) => ({
        decision_id: r.id,
        question_text: r.questionText,
        answer: r.answer,
        rationale: r.rationale,
        reviewer_slack_id: r.reviewerSlackId,
        linked_repo: r.linkedRepo,
        linked_files: r.linkedFiles,
        similarity: 1.0,
        created_at: r.createdAt.toISOString(),
      })),
    };
  }
}
