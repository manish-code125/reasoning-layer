import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { postQuestionToSlack } from "../slack/bolt-app.js";
import { embedDecision } from "../llm/embedder.js";
import { resolveStakeholder } from "../slack/routing.js";

const ENTRY_TYPES = ["decision", "wont_do", "table", "branch", "rollback", "observation"] as const;

const AnswerBody = z.object({
  answer: z.string().min(1),
  entry_type: z.enum(ENTRY_TYPES).default("decision"),
  rationale: z.string().optional(),
  alternatives_considered: z.string().optional(),
  reopen_condition: z.string().optional(),
  // Required when entry_type === "rollback" — points to the Decision being superseded
  supersedes_id: z.string().optional(),
  reasoning_arc: z.string().optional(),
});

const RouteToSlackBody = z.object({
  reviewer_slack_id: z.string().optional(),
  developer_slack_id: z.string().optional(),
});

const BatchRouteBody = z.object({
  assignments: z.array(z.object({
    question_id: z.string(),
    reviewer_slack_id: z.string(),
    reviewer_name: z.string().optional(),
  })),
  developer_slack_id: z.string().optional(),
});

function resolveReviewer(explicitId: string | undefined, category: string | null): string {
  if (explicitId) return explicitId;
  return resolveStakeholder(category).slack_id;
}

export const questionRoutes: FastifyPluginAsync = async (app) => {
  // List questions — optional ?status=<status>&repo=<repoPath>&limit=<n>
  app.get<{ Querystring: { status?: string; repo?: string; limit?: string } }>(
    "/questions",
    async (req) => {
      const { status, repo, limit } = req.query;
      const take = limit ? Math.min(parseInt(limit, 10), 200) : 50;

      const questions = await prisma.question.findMany({
        where: {
          ...(status ? { status } : {}),
          ...(repo ? { prompt: { repoPath: repo } } : {}),
        },
        include: {
          decision: { select: { id: true, answer: true, rationale: true, reviewerSlackId: true } },
        },
        orderBy: { createdAt: "desc" },
        take,
      });

      return questions.map((q) => ({
        question_id: q.id,
        text: q.text,
        category: q.category,
        risk_level: q.riskLevel,
        status: q.status,
        local_answer: q.localAnswer,
        slack_routed: q.slackRouted,
        prompt_id: q.promptId,
        decision: q.decision
          ? {
              decision_id: q.decision.id,
              answer: q.decision.answer,
              rationale: q.decision.rationale,
              reviewer_slack_id: q.decision.reviewerSlackId,
            }
          : null,
        created_at: q.createdAt.toISOString(),
      }));
    }
  );

  // Get a single question with its decision status.
  app.get<{ Params: { id: string } }>("/questions/:id", async (req, reply) => {
    const question = await prisma.question.findUnique({
      where: { id: req.params.id },
      include: { decision: { select: { id: true, answer: true, rationale: true, reviewerSlackId: true } } },
    });
    if (!question) return reply.notFound("Question not found");

    return {
      question_id: question.id,
      text: question.text,
      category: question.category,
      risk_level: question.riskLevel,
      status: question.status,
      local_answer: question.localAnswer,
      slack_routed: question.slackRouted,
      prompt_id: question.promptId,
      decision: question.decision
        ? {
            decision_id: question.decision.id,
            answer: question.decision.answer,
            rationale: question.decision.rationale,
            reviewer_slack_id: question.decision.reviewerSlackId,
          }
        : null,
      created_at: question.createdAt.toISOString(),
    };
  });

  // Developer answers a question locally (in the extension quick-pick or webview).
  // Creates a Decision record so the answer joins the persistent memory store.
  app.post<{ Params: { id: string } }>("/questions/:id/answer", async (req, reply) => {
    const parsed = AnswerBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const question = await prisma.question.findUnique({
      where: { id: req.params.id },
      include: { prompt: true },
    });
    if (!question) return reply.notFound("Question not found");

    // Decisions are immutable — only create, never update.
    // To revise, create a new entry with entry_type="rollback" and supersedes_id pointing here.
    const existingDecision = await prisma.decision.findUnique({ where: { questionId: req.params.id } });
    if (existingDecision) return reply.code(409).send({ statusCode: 409, error: "Conflict", message: "Decision already recorded for this question. To revise it, create a rollback entry with supersedes_id pointing to the existing decision." });

    const { entry_type, answer, rationale, alternatives_considered, reopen_condition, supersedes_id, reasoning_arc } = parsed.data;

    // rollback entries must reference a valid prior decision
    if (entry_type === "rollback") {
      if (!supersedes_id) return reply.badRequest("supersedes_id is required when entry_type is rollback");
      const target = await prisma.decision.findUnique({ where: { id: supersedes_id } });
      if (!target) return reply.badRequest(`supersedes_id ${supersedes_id} does not match any existing decision`);
    }

    const hexId = Math.random().toString(16).slice(2, 9);

    await prisma.question.update({
      where: { id: req.params.id },
      data: { localAnswer: answer, status: "answered_locally" },
    });
    const decision = await prisma.decision.create({
      data: {
        hexId,
        entryType: entry_type,
        questionId: req.params.id,
        questionText: question.text,
        answer,
        rationale: rationale ?? null,
        alternativesConsidered: alternatives_considered ?? null,
        reopenCondition: reopen_condition ?? null,
        supersededById: supersedes_id ?? null,
        linkedRepo: question.prompt.repoPath ?? null,
        repoId: question.prompt.repoId ?? null,
        linkedFiles: question.prompt.openFilePath ? [question.prompt.openFilePath] : [],
        reasoningArc: reasoning_arc ?? null,
      },
    });

    // Fire-and-forget — response is not delayed by embedding generation
    embedDecision(decision.id).catch(console.error);

    return reply.code(201).send({
      question_id: question.id,
      status: "answered_locally",
      decision_id: decision.id,
    });
  });

  // Route a high-risk question to a Slack reviewer.
  // Posts a Block Kit message with an "Answer" button to the escalation channel.
  // The reviewer clicks → modal opens → submission persists Decision + posts thread reply.
  app.post<{ Params: { id: string } }>("/questions/:id/route", async (req, reply) => {
    const parsed = RouteToSlackBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const question = await prisma.question.findUnique({
      where: { id: req.params.id },
      include: { prompt: true },
    });
    if (!question) return reply.notFound("Question not found");

    if (question.slackRouted) {
      return reply.code(409).send({
        statusCode: 409,
        error: "Conflict",
        message: "Question already routed to Slack",
      });
    }

    const reviewerSlackId = resolveReviewer(
      parsed.data.reviewer_slack_id,
      question.category
    );
    if (!reviewerSlackId) {
      return reply.badRequest(
        "reviewer_slack_id is required, or set DEFAULT_ARCH_SLACK_ID / DEFAULT_PM_SLACK_ID in env"
      );
    }

    // If Slack is not configured, fall back gracefully so Phase 1/2 still work
    if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_ESCALATION_CHANNEL) {
      await prisma.question.update({
        where: { id: req.params.id },
        data: { slackRouted: true, status: "routed" },
      });
      return {
        question_id: question.id,
        status: "routed",
        note: "Slack not configured — set SLACK_BOT_TOKEN and SLACK_ESCALATION_CHANNEL to enable real posting",
      };
    }

    const { ts, channel } = await postQuestionToSlack({
      questionId: question.id,
      questionText: question.text,
      promptContent: question.prompt.content,
      repoPath: question.prompt.repoPath,
      category: question.category,
      riskLevel: question.riskLevel,
      reviewerSlackId,
      developerSlackId: parsed.data.developer_slack_id,
      questionNumber: 1,
      totalQuestions: 1,
    });

    await prisma.question.update({
      where: { id: req.params.id },
      data: {
        slackRouted: true,
        status: "routed",
        slackMessageTs: ts,
        slackChannel: channel,
      },
    });

    return reply.code(201).send({
      question_id: question.id,
      status: "routed",
      slack_channel: channel,
      slack_message_ts: ts,
      reviewer_slack_id: reviewerSlackId,
    });
  });

  // Route multiple questions — all posted as thread replies under one session message.
  // Groups questions for the same reviewer under one thread so the channel stays clean.
  app.post("/questions/route-batch", async (req, reply) => {
    const parsed = BatchRouteBody.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const { assignments, developer_slack_id } = parsed.data;

    const questions = await prisma.question.findMany({
      where: { id: { in: assignments.map((a) => a.question_id) } },
      include: { prompt: true },
    });

    if (!questions.length) return reply.notFound("No questions found");

    const results = [];

    // Group by reviewer so each reviewer gets one session thread
    const byReviewer = new Map<string, typeof assignments>();
    for (const a of assignments) {
      if (!byReviewer.has(a.reviewer_slack_id)) byReviewer.set(a.reviewer_slack_id, []);
      byReviewer.get(a.reviewer_slack_id)!.push(a);
    }

    for (const [reviewerSlackId, reviewerAssignments] of byReviewer) {
      let sessionTs: string | undefined;
      const total = reviewerAssignments.length;

      for (let i = 0; i < reviewerAssignments.length; i++) {
        const assignment = reviewerAssignments[i];
        const question = questions.find((q) => q.id === assignment.question_id);
        if (!question || question.slackRouted) continue;

        const { ts, channel, sessionTs: newSessionTs } = await postQuestionToSlack({
          questionId: question.id,
          questionText: question.text,
          promptContent: question.prompt.content,
          repoPath: question.prompt.repoPath,
          category: question.category,
          riskLevel: question.riskLevel,
          reviewerSlackId,
          developerSlackId: developer_slack_id,
          sessionTs,
          questionNumber: i + 1,
          totalQuestions: total,
        });

        // Capture the session ts from the first post so subsequent questions thread under it
        if (!sessionTs) sessionTs = newSessionTs;

        await prisma.question.update({
          where: { id: question.id },
          data: { slackRouted: true, status: "routed", slackChannel: channel, slackMessageTs: ts },
        });

        results.push({
          question_id: question.id,
          reviewer_slack_id: reviewerSlackId,
          slack_message_ts: ts,
          session_ts: sessionTs,
        });
      }
    }

    return reply.code(201).send({ routed: results });
  });
};
