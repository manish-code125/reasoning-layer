import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import type { DecisionRow } from "../types.js";
import { findSimilarDecisions, embeddingAvailable, embedDecision } from "../llm/embedder.js";
import { upsertRepo, resolveRepoId } from "../db/repos.js";

const ENTRY_TYPES = ["decision", "wont_do", "table", "branch", "rollback", "observation"] as const;

const CreateDecisionBody = z.object({
  question_text: z.string().min(1),
  answer: z.string().min(1),
  entry_type: z.enum(ENTRY_TYPES).default("decision"),
  alternatives_considered: z.string().optional(),
  rationale: z.string().optional(),
  reopen_condition: z.string().optional(),
  supersedes_id: z.string().optional(),
  reviewer_slack_id: z.string().optional(),
  linked_files: z.array(z.string()).default([]),
  linked_repo: z.string().optional(),
});

type DecisionSelectResult = {
  id: string;
  decisionNumber: number;
  hexId: string;
  entryType: string;
  questionText: string;
  answer: string;
  alternativesConsidered: string | null;
  rationale: string | null;
  reopenCondition: string | null;
  supersededById: string | null;
  reviewerSlackId: string | null;
  linkedFiles: string[];
  linkedRepo: string | null;
  repoId: string | null;
  createdAt: Date;
};

function toRow(d: DecisionSelectResult): DecisionRow & { decision_number: number } {
  return {
    decision_id: d.id,
    decision_number: d.decisionNumber,
    hex_id: d.hexId,
    entry_type: d.entryType,
    question_text: d.questionText,
    answer: d.answer,
    alternatives_considered: d.alternativesConsidered,
    rationale: d.rationale,
    reopen_condition: d.reopenCondition,
    supersedes_id: d.supersededById,
    reviewer_slack_id: d.reviewerSlackId,
    linked_files: d.linkedFiles,
    linked_repo: d.linkedRepo,
    repo_id: d.repoId,
    created_at: d.createdAt.toISOString(),
  };
}

// Shared select — never returns the embedding column to avoid raw vector bytes in JSON
const decisionSelect = {
  id: true,
  decisionNumber: true,
  hexId: true,
  entryType: true,
  questionText: true,
  answer: true,
  alternativesConsidered: true,
  rationale: true,
  reopenCondition: true,
  supersededById: true,
  reviewerSlackId: true,
  linkedFiles: true,
  linkedRepo: true,
  repoId: true,
  createdAt: true,
} as const;

const ENTRY_TYPE_LABELS: Record<string, string> = {
  decision: "✅ Decision",
  wont_do: "🚫 Won't Do",
  table: "🅿 Tabled",
  branch: "🌿 Branch",
  rollback: "↩ Rollback",
  observation: "👁 Observation",
};

function formatAdr(decisions: DecisionRow[]): string {
  const sorted = [...decisions].sort((a, b) => (a as any).decision_number - (b as any).decision_number);
  // Build a lookup from id → ADR number for supersession references
  const numById = new Map<string, number>(sorted.map((d: any) => [d.decision_id, d.decision_number]));

  const header = [
    "# Architectural Decision Log",
    "",
    "> **Immutable. Append-only.** Every entry is permanent and numbered sequentially.",
    "> To revise a decision, add a new `rollback` entry with `supersedes_id` pointing to the original.",
    "> Never edit or delete entries — the integrity of this log depends on it.",
    "",
    `_Generated: ${new Date().toISOString().slice(0, 10)} · Total entries: ${sorted.length}_`,
    "",
    "---",
    "",
  ].join("\n");

  const body = sorted.map((d: any) => {
    const num = String(d.decision_number).padStart(3, "0");
    const typeLabel = ENTRY_TYPE_LABELS[d.entry_type] ?? d.entry_type;
    const hexRef = d.hex_id ? ` · \`${d.hex_id}\`` : "";
    const lines = [
      `## ADR-${num} — ${d.question_text}`,
      "",
      `| | |`,
      `|---|---|`,
      `| **Type** | ${typeLabel}${hexRef} |`,
      `| **Date** | ${d.created_at?.slice(0, 10) ?? "unknown"} |`,
    ];
    if (d.linked_repo) lines.push(`| **Repo** | \`${d.linked_repo}\` |`);
    if (d.reviewer_slack_id) lines.push(`| **Decided by** | <@${d.reviewer_slack_id}> |`);
    if (d.linked_files?.length) lines.push(`| **Files** | ${d.linked_files.join(", ")} |`);
    if (d.supersedes_id) {
      const supNum = numById.get(d.supersedes_id);
      const ref = supNum ? `ADR-${String(supNum).padStart(3, "0")}` : d.supersedes_id;
      lines.push(`| **Supersedes** | ${ref} |`);
    }
    lines.push("");
    lines.push(`**${d.entry_type === "wont_do" ? "Rejected" : d.entry_type === "observation" ? "Observation" : "Decision"}:**  `);
    lines.push(d.answer);
    lines.push("");
    if (d.rationale) {
      lines.push(`**Rationale:**  `);
      lines.push(d.rationale);
      lines.push("");
    }
    if (d.alternatives_considered) {
      lines.push(`**Alternatives considered:**  `);
      lines.push(d.alternatives_considered);
      lines.push("");
    }
    if (d.reopen_condition) {
      lines.push(`**Revisit if:** ${d.reopen_condition}`);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
    return lines.join("\n");
  }).join("\n");

  return header + body;
}

export const decisionRoutes: FastifyPluginAsync = async (app) => {
  // List decisions — optional ?repo=<repoPath>&limit=<n>
  app.get<{ Querystring: { repo?: string; limit?: string } }>("/decisions", async (req) => {
    const { repo, limit } = req.query;
    const take = limit ? Math.min(parseInt(limit, 10), 200) : 50;

    let repoFilter: object | undefined;
    if (repo) {
      const repoId = await resolveRepoId(repo);
      // Filter by repoId (FK) when available; fall back to linkedRepo string for unbackfilled rows
      repoFilter = repoId
        ? { OR: [{ repoId }, { linkedRepo: repo }] }
        : { linkedRepo: repo };
    }

    const decisions = await prisma.decision.findMany({
      where: repoFilter,
      orderBy: { createdAt: "desc" },
      take,
      select: decisionSelect,
    });

    return decisions.map(toRow);
  });

  app.get<{ Params: { id: string } }>("/decisions/:id", async (req, reply) => {
    const decision = await prisma.decision.findUnique({
      where: { id: req.params.id },
      select: decisionSelect,
    });
    if (!decision) return reply.notFound("Decision not found");
    return toRow(decision);
  });

  // Manually create a standalone decision — used for seeding historical knowledge
  // that predates this tool. questionId is intentionally null for these records.
  // Triggers embedding generation fire-and-forget so the decision is immediately searchable.
  app.post("/decisions", async (req, reply) => {
    const parsed = CreateDecisionBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const d = parsed.data;

    if (d.entry_type === "rollback" && !d.supersedes_id) {
      return reply.badRequest("supersedes_id is required when entry_type is rollback");
    }
    if (d.supersedes_id) {
      const target = await prisma.decision.findUnique({ where: { id: d.supersedes_id } });
      if (!target) return reply.badRequest(`supersedes_id ${d.supersedes_id} does not match any existing decision`);
    }

    const hexId = Math.random().toString(16).slice(2, 9);
    const repoId = d.linked_repo ? await upsertRepo(d.linked_repo) : undefined;

    const decision = await prisma.decision.create({
      data: {
        hexId,
        entryType: d.entry_type,
        questionText: d.question_text,
        answer: d.answer,
        alternativesConsidered: d.alternatives_considered ?? null,
        rationale: d.rationale ?? null,
        reopenCondition: d.reopen_condition ?? null,
        supersededById: d.supersedes_id ?? null,
        reviewerSlackId: d.reviewer_slack_id ?? null,
        linkedFiles: d.linked_files,
        linkedRepo: d.linked_repo ?? null,
        repoId: repoId ?? null,
      },
      select: decisionSelect,
    });

    // Fire-and-forget — response is not delayed by embedding generation
    embedDecision(decision.id).catch(console.error);

    return reply.code(201).send(toRow(decision));
  });

  // Export all decisions as an immutable ADR-style Markdown file.
  app.get("/decisions/export", async (_req, reply) => {
    const decisions = await prisma.decision.findMany({
      orderBy: { decisionNumber: "asc" },
      select: decisionSelect,
    });
    const markdown = formatAdr(decisions.map(toRow));
    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", "attachment; filename=DECISIONS.md")
      .send(markdown);
  });

  // Export decisions since a given timestamp for a given repo.
  // Used by /decide-log to append only new decisions since the last git commit of decision.log.md.
  // Returns plain text markdown — empty string if nothing new.
  app.get<{ Querystring: { repo?: string; since?: string } }>(
    "/decisions/export-since",
    async (req, reply) => {
      const { repo, since } = req.query;
      const sinceDate = since ? new Date(since) : new Date(0);

      const repoId = repo ? await resolveRepoId(repo) : null;

      const decisions = await prisma.decision.findMany({
        where: {
          createdAt: { gt: sinceDate },
          ...(repoId
            ? { OR: [{ repoId }, { linkedRepo: repo }] }
            : repo ? { linkedRepo: repo } : {}),
          question: {
            status: { in: ["resolved", "answered_locally"] },
          },
        },
        include: {
          question: { include: { prompt: true } },
          supersededBy: { select: { hexId: true, decisionNumber: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      if (decisions.length === 0) {
        return reply.header("Content-Type", "text/plain; charset=utf-8").send("");
      }

      // Group by prompt so each session is one block (skip orphaned decisions with no question)
      const byPrompt = new Map<string, typeof decisions>();
      for (const d of decisions) {
        if (!d.question) continue;
        const pid = d.question.promptId;
        if (!byPrompt.has(pid)) byPrompt.set(pid, []);
        byPrompt.get(pid)!.push(d);
      }

      const RISK_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };

      const blocks: string[] = [];
      for (const [, promptDecisions] of byPrompt) {
        const prompt = promptDecisions[0].question!.prompt;
        const analysis = prompt.analysis as Record<string, unknown> | null;
        const domain = (analysis?.domain as string) ?? "General";
        const risk = (analysis?.risk_level as string) ?? "unknown";
        const ts = promptDecisions[promptDecisions.length - 1].createdAt
          .toISOString().replace("T", " ").slice(0, 16) + " UTC";

        const lines: string[] = [
          `## ${ts} — ${domain} · ${RISK_EMOJI[risk] ?? "⚪"} ${risk.toUpperCase()}`,
          ``,
          `**Request:** ${prompt.content}`,
          ``,
        ];

        promptDecisions.forEach((d, i) => {
          const typeLabel = ENTRY_TYPE_LABELS[d.entryType] ?? d.entryType;
          const hexRef = d.hexId ? ` · \`${d.hexId}\`` : "";
          const questionText = d.question!.text;
          // wont_do entries use strikethrough on the question to signal rejection clearly
          const displayText = d.entryType === "wont_do" ? `~~${questionText}~~` : questionText;
          lines.push(`### ${typeLabel}${hexRef} ${i + 1} — ${displayText}`);
          lines.push(``);
          lines.push(`> ${d.answer}`);
          lines.push(``);
          if (d.rationale) lines.push(`*Rationale:* ${d.rationale}`, ``);
          if (d.alternativesConsidered) lines.push(`*Alternatives considered:* ${d.alternativesConsidered}`, ``);
          if (d.reopenCondition) lines.push(`*Revisit if:* ${d.reopenCondition}`, ``);
          if (d.supersededBy) {
            const supNum = String(d.supersededBy.decisionNumber).padStart(3, "0");
            lines.push(`*Supersedes:* ADR-${supNum} · \`${d.supersededBy.hexId}\``, ``);
          }
          if (d.reviewerSlackId) lines.push(`*Decided by:* <@${d.reviewerSlackId}>`, ``);
        });

        lines.push(`---`, ``);
        blocks.push(lines.join("\n"));
      }

      return reply
        .header("Content-Type", "text/plain; charset=utf-8")
        .send(blocks.join("\n"));
    }
  );

  // Semantic similarity search over the decision store.
  // With OPENAI_API_KEY: embeds the query text and uses pgvector cosine similarity.
  // Without: falls back to most-recent decisions (mode: "recency" in response).
  app.post("/decisions/search", async (req, reply) => {
    const parsed = z
      .object({
        text: z.string().min(1),
        repo: z.string().optional(),
        limit: z.number().int().min(1).max(20).default(5),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const repoId = parsed.data.repo ? await resolveRepoId(parsed.data.repo) : undefined;
    const { results, mode } = await findSimilarDecisions({
      text: parsed.data.text,
      repoId: repoId ?? undefined,
      repo: parsed.data.repo,
      limit: parsed.data.limit,
    });

    return {
      mode,
      embedding_available: embeddingAvailable(),
      count: results.length,
      results,
    };
  });
};
