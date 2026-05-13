import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { embedDecision } from "../llm/embedder.js";
import { upsertRepo } from "../db/repos.js";

const AddMessageBody = z.object({
  role: z.enum(["developer", "reviewer", "ai"]),
  content: z.string().min(1),
  slack_ts: z.string().optional(),
});

const SettleBody = z.object({
  answer: z.string().min(1),
  entry_type: z.enum(["decision", "wont_do", "observation"]).default("decision"),
  rationale: z.string().optional(),
  alternatives_considered: z.string().optional(),
  reopen_condition: z.string().optional(),
  reviewer_slack_id: z.string().optional(),
});

const TableBody = z.object({
  rationale: z.string().optional(),
  reopen_condition: z.string().optional(),
});

function assembleReasoningArc(messages: Array<{ role: string; content: string; createdAt: Date }>): string {
  return messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");
}

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  // GET /sessions/catch-up — decisions that landed + questions still in-flight since a timestamp
  // Must be registered before /sessions/:id to avoid route conflict
  app.get<{ Querystring: { repo?: string; since?: string } }>(
    "/sessions/catch-up",
    async (req) => {
      const { repo, since } = req.query;
      const sinceDate = since ? new Date(since) : new Date(0);

      // Resolved decisions that landed since the timestamp (exclude interim table entries)
      const settledDecisions = await prisma.decision.findMany({
        where: {
          createdAt: { gt: sinceDate },
          entryType: { not: "table" },
          ...(repo
            ? { OR: [{ linkedRepo: repo }, { repo: { path: repo } }] }
            : {}),
        },
        include: {
          question: { select: { text: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      });

      // Open sessions = in-flight questions
      const openSessions = await prisma.refiningSession.findMany({
        where: {
          status: "open",
          ...(repo
            ? {
                prompt: {
                  OR: [{ repoPath: repo }, { repo: { path: repo } }],
                },
              }
            : {}),
        },
        include: {
          question: { select: { id: true, text: true, riskLevel: true } },
          messages: { orderBy: { createdAt: "asc" } },
        },
        orderBy: { createdAt: "desc" },
      });

      return {
        settled_since: settledDecisions.map((d) => ({
          decision_id: d.id,
          hex_id: d.hexId,
          entry_type: d.entryType,
          question_text: d.questionText,
          answer: d.answer,
          rationale: d.rationale,
          reasoning_arc: d.reasoningArc,
          created_at: d.createdAt.toISOString(),
        })),
        in_flight: openSessions.map((s) => ({
          session_id: s.id,
          question_id: s.questionId,
          question_text: s.question?.text ?? s.topic,
          risk_level: s.question?.riskLevel ?? "medium",
          interim_decision_id: s.interimDecisionId,
          turn_count: s.messages.length,
          created_at: s.createdAt.toISOString(),
        })),
      };
    }
  );

  // GET /sessions/:id — full session state + message history
  app.get<{ Params: { id: string } }>("/sessions/:id", async (req, reply) => {
    const session = await prisma.refiningSession.findUnique({
      where: { id: req.params.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        question: { select: { id: true, text: true, riskLevel: true, status: true } },
        decisions: { select: { id: true, hexId: true, entryType: true, answer: true, createdAt: true } },
      },
    });
    if (!session) return reply.notFound("Session not found");

    return {
      session_id: session.id,
      prompt_id: session.promptId,
      question_id: session.questionId,
      topic: session.topic,
      status: session.status,
      outcome: session.outcome,
      interim_decision_id: session.interimDecisionId,
      created_at: session.createdAt.toISOString(),
      settled_at: session.settledAt?.toISOString() ?? null,
      messages: session.messages.map((m) => ({
        message_id: m.id,
        role: m.role,
        content: m.content,
        slack_ts: m.slackTs,
        created_at: m.createdAt.toISOString(),
      })),
      decisions: session.decisions.map((d) => ({
        decision_id: d.id,
        hex_id: d.hexId,
        entry_type: d.entryType,
        answer: d.answer,
        created_at: d.createdAt.toISOString(),
      })),
      question: session.question,
    };
  });

  // POST /sessions/:id/messages — add a dialogue turn
  app.post<{ Params: { id: string } }>("/sessions/:id/messages", async (req, reply) => {
    const parsed = AddMessageBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const session = await prisma.refiningSession.findUnique({ where: { id: req.params.id } });
    if (!session) return reply.notFound("Session not found");
    if (session.status !== "open") return reply.code(409).send({ error: "Session is not open", status: session.status });

    const message = await prisma.sessionMessage.create({
      data: {
        sessionId: session.id,
        role: parsed.data.role,
        content: parsed.data.content,
        slackTs: parsed.data.slack_ts ?? null,
      },
    });

    return reply.code(201).send({
      message_id: message.id,
      session_id: session.id,
      role: message.role,
      content: message.content,
      created_at: message.createdAt.toISOString(),
    });
  });

  // POST /sessions/:id/settle — write final WAL entry; supersede interim table entry; close session
  app.post<{ Params: { id: string } }>("/sessions/:id/settle", async (req, reply) => {
    const parsed = SettleBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const session = await prisma.refiningSession.findUnique({
      where: { id: req.params.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        question: { include: { prompt: true } },
      },
    });
    if (!session) return reply.notFound("Session not found");
    if (session.status !== "open") return reply.code(409).send({ error: "Session is not open", status: session.status });

    const { answer, entry_type, rationale, alternatives_considered, reopen_condition, reviewer_slack_id } = parsed.data;

    const repoId = session.question?.prompt.repoPath
      ? await upsertRepo(session.question.prompt.repoPath).catch(() => null)
      : session.question?.prompt.repoId ?? null;

    const hexId = Math.random().toString(16).slice(2, 9);
    const reasoningArc = session.messages.length > 0 ? assembleReasoningArc(session.messages) : null;

    // Final WAL entry — supersedes the interim table entry
    const decision = await prisma.decision.create({
      data: {
        hexId,
        entryType: entry_type,
        questionId: session.questionId ?? undefined,
        questionText: session.question?.text ?? session.topic,
        answer,
        rationale: rationale ?? null,
        alternativesConsidered: alternatives_considered ?? null,
        reopenCondition: reopen_condition ?? null,
        supersededById: session.interimDecisionId ?? null,
        reviewerSlackId: reviewer_slack_id ?? null,
        linkedRepo: session.question?.prompt.repoPath ?? null,
        repoId: repoId ?? null,
        linkedFiles: session.question?.prompt.openFilePath ? [session.question.prompt.openFilePath] : [],
        reasoningArc,
        sessionId: session.id,
      },
    });

    // Close the session
    await prisma.refiningSession.update({
      where: { id: session.id },
      data: { status: "settled", outcome: entry_type, settledAt: new Date() },
    });

    // Mark question resolved
    if (session.questionId) {
      await prisma.question.update({ where: { id: session.questionId }, data: { status: "resolved" } });
    }

    embedDecision(decision.id).catch(console.error);

    return reply.code(201).send({
      decision_id: decision.id,
      hex_id: hexId,
      entry_type,
      session_id: session.id,
      reasoning_arc: reasoningArc,
      supersedes_interim: session.interimDecisionId,
    });
  });

  // POST /sessions/:id/table — defer; update the interim entry with explicit reopen condition; close session
  app.post<{ Params: { id: string } }>("/sessions/:id/table", async (req, reply) => {
    const parsed = TableBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const session = await prisma.refiningSession.findUnique({
      where: { id: req.params.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!session) return reply.notFound("Session not found");
    if (session.status !== "open") return reply.code(409).send({ error: "Session is not open", status: session.status });

    // Enrich the interim decision with the dialogue and explicit reopen condition
    if (session.interimDecisionId) {
      const reasoningArc = session.messages.length > 0 ? assembleReasoningArc(session.messages) : null;
      await prisma.decision.update({
        where: { id: session.interimDecisionId },
        data: {
          rationale: parsed.data.rationale ?? "Explicitly tabled after discussion.",
          reopenCondition: parsed.data.reopen_condition ?? null,
          reasoningArc,
        },
      });
    }

    await prisma.refiningSession.update({
      where: { id: session.id },
      data: { status: "tabled", outcome: "table", settledAt: new Date() },
    });

    if (session.questionId) {
      await prisma.question.update({ where: { id: session.questionId }, data: { status: "routed" } });
    }

    return { session_id: session.id, status: "tabled", interim_decision_id: session.interimDecisionId };
  });

  // POST /sessions/:id/abandon — close without a WAL entry
  app.post<{ Params: { id: string } }>("/sessions/:id/abandon", async (req, reply) => {
    const session = await prisma.refiningSession.findUnique({ where: { id: req.params.id } });
    if (!session) return reply.notFound("Session not found");
    if (session.status !== "open") return reply.code(409).send({ error: "Session is not open", status: session.status });

    await prisma.refiningSession.update({
      where: { id: session.id },
      data: { status: "abandoned", settledAt: new Date() },
    });

    return { session_id: session.id, status: "abandoned" };
  });
};
