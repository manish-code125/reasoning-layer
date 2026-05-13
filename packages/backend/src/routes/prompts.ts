import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { classifyPrompt, generateQuestions } from "../llm/analyzer.js";
import { findSimilarDecisions } from "../llm/embedder.js";
import { upsertRepo, resolveRepoId } from "../db/repos.js";

const SubmitPromptBody = z.object({
  content: z.string().min(1),
  repo_path: z.string().optional(),
  open_file_path: z.string().optional(),
  language: z.string().optional(),
  file_tree: z.record(z.unknown()).optional(),
  readme_snippet: z.string().optional(),
});

// DB status → UI QuestionStatus
function mapStatus(dbStatus: string): string {
  if (dbStatus === "answered_locally" || dbStatus === "resolved") return "answered";
  if (dbStatus === "routed") return "routed";
  if (dbStatus === "skipped") return "skipped";
  return "pending";
}

export const promptRoutes: FastifyPluginAsync = async (app) => {
  // List all prompts (most recent first) — used by the UI dashboard
  app.get("/prompts", async (_req, reply) => {
    const prompts = await prisma.prompt.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { questions: true } } },
    });
    return prompts.map((p) => {
      const analysis = p.analysis as Record<string, unknown> | null;
      return {
        prompt_id: p.id,
        content: p.content,
        created_at: p.createdAt.toISOString(),
        risk_level: analysis?.risk_level ?? null,
        domain: analysis?.domain ?? null,
        question_count: p._count.questions,
      };
    });
  });

  // Submit a developer prompt — returns prompt_id immediately, analysis is async
  app.post("/prompts", async (req, reply) => {
    const parsed = SubmitPromptBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { content, repo_path, open_file_path, language, file_tree, readme_snippet } = parsed.data;

    const repoId = repo_path ? await upsertRepo(repo_path) : undefined;

    const prompt = await prisma.prompt.create({
      data: {
        content,
        repoPath: repo_path,
        repoId: repoId ?? null,
        openFilePath: open_file_path,
        language,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fileTree: file_tree as any,
        readmeSnippet: readme_snippet,
        status: "pending",
      },
    });

    return reply.code(201).send({
      prompt_id: prompt.id,
      status: prompt.status,
      created_at: prompt.createdAt.toISOString(),
    });
  });

  // Get a prompt with its current status, analysis, and all questions + decisions
  app.get<{ Params: { id: string } }>("/prompts/:id", async (req, reply) => {
    const prompt = await prisma.prompt.findUnique({
      where: { id: req.params.id },
      include: {
        questions: {
          include: { decision: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!prompt) return reply.notFound("Prompt not found");

    return {
      prompt_id: prompt.id,
      content: prompt.content,
      status: prompt.status,
      analysis: prompt.analysis,
      enriched_prompt: prompt.enrichedPrompt,
      repo_path: prompt.repoPath,
      open_file_path: prompt.openFilePath,
      language: prompt.language,
      questions: prompt.questions.map((q) => ({
        question_id: q.id,
        text: q.text,
        category: q.category,
        risk_level: q.riskLevel,
        should_escalate: q.riskLevel === "critical" || q.riskLevel === "high",
        status: mapStatus(q.status),
        answer: q.decision?.answer ?? q.localAnswer ?? undefined,
        rationale: q.decision?.rationale ?? undefined,
        slack_routed: q.slackRouted,
        decision_id: q.decision?.id ?? undefined,
      })),
      created_at: prompt.createdAt.toISOString(),
    };
  });

  // Classify prompt intent, score risk, and generate targeted clarification questions.
  // Two sequential LLM calls: classifyPrompt (Haiku) → generateQuestions (Sonnet).
  app.post<{ Params: { id: string } }>("/prompts/:id/analyze", async (req, reply) => {
    const prompt = await prisma.prompt.findUnique({ where: { id: req.params.id } });
    if (!prompt) return reply.notFound("Prompt not found");

    if (prompt.status === "analyzing") {
      return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "Analysis already in progress" });
    }
    if (prompt.status !== "pending") {
      return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "Prompt already analyzed" });
    }

    // Mark as analyzing immediately so concurrent requests are rejected cleanly.
    await prisma.prompt.update({ where: { id: prompt.id }, data: { status: "analyzing" } });

    try {
      // Step 1: intent classification + risk scoring via Haiku
      const analysis = await classifyPrompt({
        content: prompt.content,
        repoPath: prompt.repoPath,
        openFilePath: prompt.openFilePath,
        language: prompt.language,
        readmeSnippet: prompt.readmeSnippet,
      });

      // Step 2: generate targeted questions using the analysis as context, via Sonnet
      const questions = await generateQuestions({ content: prompt.content, analysis });

      await prisma.$transaction([
        prisma.prompt.update({
          where: { id: prompt.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          data: { status: "analyzed", analysis: analysis as any },
        }),
        ...questions.map((q) =>
          prisma.question.create({
            data: {
              promptId: prompt.id,
              text: q.text,
              category: q.category,
              riskLevel: q.risk_level,
              suggestedEntryType: q.suggested_entry_type,
            },
          })
        ),
      ]);

      return {
        prompt_id: prompt.id,
        analysis,
        questions_generated: questions.length,
        questions: questions.map((q) => ({
          text: q.text,
          category: q.category,
          risk_level: q.risk_level,
          should_escalate: q.should_escalate,
          suggested_entry_type: q.suggested_entry_type,
        })),
      };
    } catch (err) {
      // Roll back to pending so the developer can retry after fixing the issue (e.g. bad API key).
      await prisma.prompt.update({ where: { id: prompt.id }, data: { status: "pending" } });
      throw err;
    }
  });

  // Return just the questions for a prompt, ordered by risk level descending
  app.get<{ Params: { id: string } }>("/prompts/:id/questions", async (req, reply) => {
    const prompt = await prisma.prompt.findUnique({
      where: { id: req.params.id },
      include: {
        questions: { orderBy: { riskLevel: "desc" } },
      },
    });
    if (!prompt) return reply.notFound("Prompt not found");

    return prompt.questions.map((q) => ({
      question_id: q.id,
      text: q.text,
      category: q.category,
      risk_level: q.riskLevel,
      status: q.status,
      local_answer: q.localAnswer,
      slack_routed: q.slackRouted,
    }));
  });

  // Return a formatted markdown block for this prompt's decisions, suitable for
  // appending to decision.log.md in the developer's repo.
  app.get<{ Params: { id: string } }>("/prompts/:id/decision-log", async (req, reply) => {
    const prompt = await prisma.prompt.findUnique({
      where: { id: req.params.id },
      include: {
        questions: {
          include: { decision: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    if (!prompt) return reply.notFound("Prompt not found");

    const entry = buildDecisionLogEntry(prompt);
    reply.header("Content-Type", "text/plain; charset=utf-8");
    return reply.send(entry);
  });

  // Return enriched prompt with injected decision context (Phase 5).
  // Searches the decision store for past decisions similar to this prompt,
  // prepends a formatted context block, and persists the result.
  // Idempotent: second call returns the cached enrichedPrompt immediately.
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/prompts/:id/enriched",
    async (req, reply) => {
      const prompt = await prisma.prompt.findUnique({ where: { id: req.params.id } });
      if (!prompt) return reply.notFound("Prompt not found");

      if (prompt.enrichedPrompt) {
        return {
          prompt_id: prompt.id,
          enriched_prompt: prompt.enrichedPrompt,
          relevant_decisions: [],
          mode: "cached",
        };
      }

      const limit = Math.min(parseInt(req.query.limit ?? "5", 10), 10);

      // Pass 1 — semantic similarity search over all decisions for this repo
      const { results, mode } = await findSimilarDecisions({
        text: prompt.content,
        repoId: prompt.repoId ?? undefined,
        repo: prompt.repoPath ?? undefined,
        limit,
      });

      // Pass 2 — tracked artifact constraints
      // If the prompt has an open file path that is a tracked artifact, prepend
      // its linked decisions as hard constraints (regardless of semantic score).
      const artifactConstraints: Array<{ file_path: string; decisions: typeof results }> = [];
      if (prompt.repoId && prompt.openFilePath) {
        const artifact = await prisma.trackedArtifact.findUnique({
          where: { repoId_filePath: { repoId: prompt.repoId, filePath: prompt.openFilePath } },
          include: {
            links: {
              include: {
                decision: {
                  select: {
                    id: true,
                    hexId: true,
                    entryType: true,
                    questionText: true,
                    answer: true,
                    rationale: true,
                    supersededById: true,
                    // supersedes: decisions that point AT this one — non-empty means this decision has been superseded
                    supersedes: { select: { id: true, hexId: true } },
                    createdAt: true,
                  },
                },
              },
              orderBy: { decision: { createdAt: "desc" } },
            },
          },
        });

        if (artifact?.links.length) {
          artifactConstraints.push({
            file_path: artifact.filePath,
            decisions: artifact.links.map((l) => ({
              decision_id: l.decision.id,
              hex_id: l.decision.hexId,
              entry_type: l.decision.entryType,
              question_text: l.decision.questionText,
              answer: l.decision.answer,
              rationale: l.decision.rationale ?? null,
              score: 1.0,
              // A decision is superseded when a newer decision points at it via supersededById
              superseded: l.decision.supersedes.length > 0,
              superseded_by: l.decision.supersedes[0]?.hexId ?? null,
            })),
          });
        }
      }

      // Pass 3 — in-flight questions: routed but not yet settled, with their interim assumptions
      const inFlightQuestions: Array<{ question_id: string; text: string; assumption: string; session_id: string }> = [];
      if (prompt.repoId || prompt.repoPath) {
        const openSessions = await prisma.refiningSession.findMany({
          where: {
            status: "open",
            prompt: {
              OR: [
                ...(prompt.repoId ? [{ repoId: prompt.repoId }] : []),
                ...(prompt.repoPath ? [{ repoPath: prompt.repoPath }] : []),
              ],
            },
          },
          include: {
            question: { select: { id: true, text: true } },
            decisions: { where: { entryType: "table" }, orderBy: { createdAt: "desc" }, take: 1 },
          },
        });

        for (const session of openSessions) {
          const interimAnswer = session.decisions[0]?.answer ?? "proceeding with best judgment";
          inFlightQuestions.push({
            question_id: session.questionId ?? "",
            text: session.question?.text ?? session.topic,
            assumption: interimAnswer,
            session_id: session.id,
          });
        }
      }

      const enriched = buildEnrichedPrompt(prompt.content, results, artifactConstraints, inFlightQuestions);

      await prisma.prompt.update({
        where: { id: prompt.id },
        data: { enrichedPrompt: enriched, status: prompt.status === "analyzed" ? "enriched" : prompt.status },
      });

      return {
        prompt_id: prompt.id,
        enriched_prompt: enriched,
        relevant_decisions: results,
        artifact_constraints: artifactConstraints,
        in_flight_questions: inFlightQuestions,
        mode,
        decisions_injected: results.length,
        artifact_constraints_injected: artifactConstraints.reduce((n, c) => n + c.decisions.length, 0),
      };
    }
  );
};

const RISK_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
const STATUS_EMOJI: Record<string, string> = { answered: "✅", routed: "📤", skipped: "⏭️", pending: "⏳" };

type PromptWithQuestions = {
  id: string;
  content: string;
  repoPath: string | null;
  createdAt: Date;
  analysis: unknown;
  questions: Array<{
    id: string;
    text: string;
    category: string | null;
    riskLevel: string;
    status: string;
    slackRouted: boolean;
    localAnswer: string | null;
    decision: { answer: string; rationale: string | null } | null;
  }>;
};

function buildDecisionLogEntry(prompt: PromptWithQuestions): string {
  const analysis = prompt.analysis as Record<string, unknown> | null;
  const domain = (analysis?.domain as string) ?? "General";
  const riskLevel = (analysis?.risk_level as string) ?? "unknown";
  const riskEmoji = RISK_EMOJI[riskLevel] ?? "⚪";

  const ts = prompt.createdAt.toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const answered  = prompt.questions.filter(q => q.status === "answered_locally" || q.status === "resolved").length;
  const routed    = prompt.questions.filter(q => q.status === "routed").length;
  const pending   = prompt.questions.filter(q => q.status === "unanswered").length;
  const skipped   = prompt.questions.filter(q => q.status === "skipped").length;

  const statParts: string[] = [];
  if (answered) statParts.push(`${answered} answered`);
  if (routed)   statParts.push(`${routed} routed`);
  if (pending)  statParts.push(`${pending} pending`);
  if (skipped)  statParts.push(`${skipped} skipped`);

  const lines: string[] = [
    `## ${ts} — \`${prompt.id.slice(0, 8)}\` — ${domain} · ${riskEmoji} ${riskLevel.toUpperCase()}`,
    ``,
    `**Request:** ${prompt.content}`,
    ``,
    `| # | Question | Risk | Status |`,
    `|---|---|---|---|`,
  ];

  prompt.questions.forEach((q, i) => {
    const uiStatus = mapStatus(q.status);
    const truncated = q.text.length > 70 ? q.text.slice(0, 67) + "…" : q.text;
    lines.push(`| ${i + 1} | ${truncated} | ${RISK_EMOJI[q.riskLevel] ?? "⚪"} ${q.riskLevel} | ${STATUS_EMOJI[uiStatus]} ${uiStatus} |`);
  });

  lines.push(``);

  prompt.questions.forEach((q, i) => {
    const answer = q.decision?.answer ?? q.localAnswer;
    const rationale = q.decision?.rationale;
    if (!answer && q.status !== "routed") return;

    lines.push(`### Decision ${i + 1} — ${q.text}`);
    lines.push(``);
    if (answer) {
      lines.push(`> ${answer}`);
      lines.push(``);
    } else {
      lines.push(`> *Routed to stakeholder — pending response*`);
      lines.push(``);
    }
    if (rationale) {
      lines.push(`*Rationale:* ${rationale}`);
      lines.push(``);
    }
  });

  lines.push(`*${statParts.join(" · ")} · repo: ${prompt.repoPath ?? "unspecified"}*`);
  lines.push(``);
  lines.push(`---`);
  lines.push(``);

  return lines.join("\n");
}

type DecisionResult = {
  decision_id: string;
  question_text: string;
  answer: string;
  rationale: string | null;
  linked_repo: string | null;
  linked_files: string[];
  similarity: number;
};

type ArtifactConstraint = {
  file_path: string;
  decisions: Array<{ hex_id: string; entry_type: string; question_text: string; answer: string; rationale: string | null; superseded?: boolean }>;
};

type InFlightQuestion = { question_id: string; text: string; assumption: string; session_id: string };

function buildEnrichedPrompt(
  originalPrompt: string,
  decisions: DecisionResult[],
  artifactConstraints: ArtifactConstraint[] = [],
  inFlightQuestions: InFlightQuestion[] = [],
): string {
  if (decisions.length === 0 && artifactConstraints.length === 0 && inFlightQuestions.length === 0) return originalPrompt;

  const lines: string[] = [];

  // Artifact constraints come first — they are hard constraints tied to the open file
  if (artifactConstraints.length > 0) {
    lines.push("## Hard Constraints — Tracked File Decisions");
    lines.push("These decisions directly govern the file you are editing. Treat them as non-negotiable constraints.");
    lines.push("");

    for (const constraint of artifactConstraints) {
      lines.push(`### File: \`${constraint.file_path}\``);
      for (const d of constraint.decisions) {
        const supersededNote = d.superseded
          ? ` ⚠️ **SUPERSEDED by \`${(d as any).superseded_by ?? "unknown"}\` — use the newer entry**`
          : "";
        lines.push(`- **\`${d.hex_id}\`** [${d.entry_type}]${supersededNote}`);
        lines.push(`  **Q:** ${d.question_text}`);
        lines.push(`  **A:** ${d.answer}`);
        if (d.rationale) lines.push(`  *Rationale:* ${d.rationale}`);
        lines.push("");
      }
    }
    lines.push("---", "");
  }

  // Semantic search results — relevant but not necessarily tied to the open file
  if (decisions.length > 0) {
    lines.push("## Relevant Past Decisions");
    lines.push("Apply these when relevant — they represent settled architectural choices for this codebase.");
    lines.push("");

    decisions.forEach((d, i) => {
      lines.push(`### Decision ${i + 1} (similarity: ${d.similarity.toFixed(2)})`);
      lines.push(`**Q:** ${d.question_text}`);
      lines.push(`**A:** ${d.answer}`);
      if (d.rationale) lines.push(`*Rationale:* ${d.rationale}`);
      if (d.linked_files.length > 0) lines.push(`*Files:* ${d.linked_files.join(", ")}`);
      if (d.linked_repo) lines.push(`*Repo:* ${d.linked_repo}`);
      lines.push("");
    });

    lines.push("---", "");
  }

  // In-flight questions — working assumptions the developer is proceeding with
  if (inFlightQuestions.length > 0) {
    lines.push("## In-Flight Questions — Working Assumptions");
    lines.push("These questions are awaiting reviewer input. The developer is proceeding with the stated assumption — treat it as provisional until resolved.");
    lines.push("");
    for (const q of inFlightQuestions) {
      lines.push(`- **Q:** ${q.text}`);
      lines.push(`  **Assumption:** ${q.assumption}`);
      lines.push(`  *(session \`${q.session_id.slice(0, 8)}\` — in-flight)*`);
      lines.push("");
    }
    lines.push("---", "");
  }

  lines.push("## Developer Request", "", originalPrompt);
  return lines.join("\n");
}
