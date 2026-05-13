import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";

const ContextLogQuery = z.object({
  since: z.string().optional(),
  type: z.string().optional(),
  format: z.enum(["narrative", "adr"]).default("narrative"),
});

async function resolveRepo(idOrPath: string) {
  const byId = await prisma.repo.findUnique({ where: { id: idOrPath } });
  if (byId) return byId;
  return prisma.repo.findUnique({ where: { path: idOrPath } });
}

type DecisionForLog = {
  id: string;
  decisionNumber: number;
  hexId: string;
  entryType: string;
  questionText: string;
  answer: string;
  rationale: string | null;
  alternativesConsidered: string | null;
  reopenCondition: string | null;
  reviewerSlackId: string | null;
  reasoningArc: string | null;
  createdAt: Date;
  supersededBy: { hexId: string } | null;   // decision this entry supersedes (rollback only)
  supersedes: { hexId: string }[];           // decisions that supersede this one
};

function formatNarrative(decisions: DecisionForLog[], repoPath: string): string {
  if (decisions.length === 0) return `# Context Log — ${repoPath}\n\n_No decisions recorded yet._\n`;

  const header = [
    `# Context Log — ${repoPath}`,
    ``,
    `> Append-only WAL. Generated from Postgres on ${new Date().toISOString().slice(0, 10)}.`,
    `> Total entries: ${decisions.length}`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const ANSWER_LABEL: Record<string, string> = {
    decision: "Decision",
    wont_do: "Rejected",
    table: "Tabled",
    branch: "Branch",
    rollback: "Decision",
    observation: "Observation",
  };

  const body = decisions.map((d) => {
    const date = d.createdAt.toISOString().slice(0, 10);
    const lines: string[] = [
      `## \`${d.hexId}\` — ${d.entryType} — ${date}`,
      ``,
    ];

    // Superseded warning — this entry has been rolled back by a newer one
    if (d.supersedes.length > 0) {
      lines.push(`> ⚠ **Superseded by \`${d.supersedes[0].hexId}\`** — the newer entry takes precedence.`);
      lines.push(``);
    }

    // For rollback entries, show what they supersede first
    if (d.entryType === "rollback" && d.supersededBy) {
      lines.push(`**Supersedes:** \`${d.supersededBy.hexId}\``);
      lines.push(``);
    }

    lines.push(`**Question:** ${d.questionText}`);
    lines.push(``);
    lines.push(`**${ANSWER_LABEL[d.entryType] ?? "Decision"}:** ${d.answer}`);
    lines.push(``);

    if (d.rationale) {
      lines.push(`**Rationale:** ${d.rationale}`);
      lines.push(``);
    }
    if (d.alternativesConsidered) {
      lines.push(`**Alternatives considered:** ${d.alternativesConsidered}`);
      lines.push(``);
    }
    if (d.reopenCondition) {
      lines.push(`**Revisit if:** ${d.reopenCondition}`);
      lines.push(``);
    }
    if (d.reasoningArc) {
      lines.push(`**Reasoning arc:**`);
      lines.push(``);
      // Indent each turn for readability
      d.reasoningArc.split("\n").forEach((line) => lines.push(`> ${line}`));
      lines.push(``);
    }
    if (d.reviewerSlackId) {
      lines.push(`**Decided by:** <@${d.reviewerSlackId}>`);
      lines.push(``);
    }

    lines.push(`---`);
    lines.push(``);
    return lines.join("\n");
  }).join("\n");

  return header + body;
}

function formatAdr(decisions: DecisionForLog[], repoPath: string): string {
  if (decisions.length === 0) return `# Architectural Decision Log — ${repoPath}\n\n_No decisions recorded yet._\n`;

  const header = [
    `# Architectural Decision Log — ${repoPath}`,
    ``,
    `> **Immutable. Append-only.** To revise a decision, add a \`rollback\` entry.`,
    ``,
    `_Generated: ${new Date().toISOString().slice(0, 10)} · Total entries: ${decisions.length}_`,
    ``,
    `---`,
    ``,
  ].join("\n");

  const body = decisions.map((d) => {
    const num = String(d.decisionNumber).padStart(3, "0");
    const date = d.createdAt.toISOString().slice(0, 10);
    const lines: string[] = [
      `## ADR-${num} — ${d.questionText}`,
      ``,
      `| | |`,
      `|---|---|`,
      `| **Type** | ${d.entryType} · \`${d.hexId}\` |`,
      `| **Date** | ${date} |`,
    ];

    if (d.reviewerSlackId) lines.push(`| **Decided by** | <@${d.reviewerSlackId}> |`);
    if (d.supersededBy) lines.push(`| **Supersedes** | \`${d.supersededBy.hexId}\` |`);
    if (d.supersedes.length > 0) lines.push(`| **Superseded by** | \`${d.supersedes[0].hexId}\` ⚠ |`);

    lines.push(``, `**${d.entryType === "wont_do" ? "Rejected" : "Decision"}:** ${d.answer}`, ``);
    if (d.rationale) lines.push(`**Rationale:** ${d.rationale}`, ``);
    if (d.alternativesConsidered) lines.push(`**Alternatives considered:** ${d.alternativesConsidered}`, ``);
    if (d.reopenCondition) lines.push(`**Revisit if:** ${d.reopenCondition}`, ``);
    if (d.reasoningArc) lines.push(`**Reasoning arc:** ${d.reasoningArc}`, ``);
    lines.push(`---`, ``);
    return lines.join("\n");
  }).join("\n");

  return header + body;
}

export const repoRoutes: FastifyPluginAsync = async (app) => {
  // GET /repos/:id/context-log — full WAL for a repo as readable markdown.
  // :id can be the repo UUID or the repo path (e.g. /Users/dev/my-project).
  // Query params:
  //   ?since=<iso>          — entries after this timestamp
  //   ?type=<entry_type>    — filter by decision type
  //   ?format=narrative|adr  — output format (default: narrative)
  app.get<{
    Params: { id: string };
    Querystring: { since?: string; type?: string; format?: string };
  }>("/repos/:id/context-log", async (req, reply) => {
    const repo = await resolveRepo(req.params.id);
    if (!repo) return reply.notFound("Repo not found");

    const parsed = ContextLogQuery.safeParse(req.query);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { since, type, format } = parsed.data;
    const sinceDate = since ? new Date(since) : new Date(0);

    const decisions = await prisma.decision.findMany({
      where: {
        OR: [{ repoId: repo.id }, { linkedRepo: repo.path }],
        createdAt: { gte: sinceDate },
        ...(type ? { entryType: type } : {}),
      },
      select: {
        id: true,
        decisionNumber: true,
        hexId: true,
        entryType: true,
        questionText: true,
        answer: true,
        rationale: true,
        alternativesConsidered: true,
        reopenCondition: true,
        reviewerSlackId: true,
        reasoningArc: true,
        createdAt: true,
        // supersededBy = the decision this entry supersedes (for rollback entries)
        supersededBy: { select: { hexId: true } },
        // supersedes = decisions that point at this one (means this one has been rolled back)
        supersedes: { select: { hexId: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const markdown = format === "adr"
      ? formatAdr(decisions, repo.path)
      : formatNarrative(decisions, repo.path);

    return reply
      .header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename=context_log.md`)
      .send(markdown);
  });
};
