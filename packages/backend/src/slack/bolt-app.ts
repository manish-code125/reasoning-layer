import { App } from "@slack/bolt";
import { prisma } from "../db.js";
import { buildAnswerModal, buildAnsweredQuestionBlocks, buildQuestionBlocks, buildSessionBlocks } from "./message-builder.js";
import { embedDecision } from "../llm/embedder.js";
import { upsertRepo } from "../db/repos.js";

export const boltApp = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
  // Suppress the default logger noise — Fastify owns logging in this process
  logLevel: "warn" as never,
});

// ── Button: "Answer this question" ────────────────────────────────────────────
// Ack first (Slack requires a response within 3s), then open the modal.
// The question text is fetched from DB so the modal always shows current data.
boltApp.action("answer_question", async ({ ack, body, client }) => {
  await ack();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = body as any;
  const questionId = b.actions[0].value as string;

  const question = await prisma.question.findUnique({
    where: { id: questionId },
  });
  if (!question) return;

  await client.views.open({
    trigger_id: b.trigger_id,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view: buildAnswerModal(questionId, question.text, question.suggestedEntryType ?? "decision") as any,
  });
});

// ── Thread reply listener ──────────────────────────────────────────────────────
// Questions are posted as thread replies to a session message.
// Reviewers reply within that same thread — we match by slackMessageTs (the question's own ts).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
boltApp.event("message", async ({ event, client }: any) => {
  // Only thread replies; ignore top-level posts, bot messages, edits, deletes
  if (!event.thread_ts || event.thread_ts === event.ts) return;
  if (event.subtype) return;
  if (event.bot_id) return;
  if (!event.text?.trim()) return;

  console.log(`[bolt] thread reply: channel=${event.channel} thread_ts=${event.thread_ts} ts=${event.ts} user=${event.user}`);

  // Match by the question's own message ts (question is posted as a thread reply,
  // so its ts !== thread_ts; we stored it in slackMessageTs when routing).
  const question = await prisma.question.findFirst({
    where: {
      slackMessageTs: event.ts === event.thread_ts ? event.thread_ts : event.thread_ts,
      slackChannel: event.channel,
      status: { notIn: ["resolved", "answered_locally"] },
    },
    include: { prompt: true },
  });

  // Also try matching by the parent thread ts in case the question IS the thread parent
  const questionByParent = question ?? await prisma.question.findFirst({
    where: {
      slackMessageTs: event.thread_ts,
      slackChannel: event.channel,
      status: { notIn: ["resolved", "answered_locally"] },
    },
    include: { prompt: true },
  });

  const matched = questionByParent;
  if (!matched) {
    console.log(`[bolt] no open question found for thread_ts=${event.thread_ts} channel=${event.channel}`);
    return;
  }

  const existing = await prisma.decision.findUnique({ where: { questionId: matched.id } });
  if (existing) {
    console.log(`[bolt] question ${matched.id} already answered — ignoring duplicate reply`);
    return;
  }

  const hexId = Math.random().toString(16).slice(2, 9);
  const repoId = matched.prompt.repoPath
    ? await upsertRepo(matched.prompt.repoPath).catch(() => null)
    : null;

  await prisma.question.update({ where: { id: matched.id }, data: { status: "resolved" } });
  await prisma.decision.create({
    data: {
      hexId,
      entryType: "decision",
      questionId: matched.id,
      questionText: matched.text,
      answer: event.text,
      rationale: null,
      reviewerSlackId: event.user,
      linkedRepo: matched.prompt.repoPath ?? null,
      repoId: repoId ?? null,
      linkedFiles: matched.prompt.openFilePath ? [matched.prompt.openFilePath] : [],
      reasoningArc: null,  // thread replies are fast-path — no dialogue arc captured
    },
  });

  embedDecision(matched.id).catch((e: unknown) => console.error("[bolt] embed failed:", e));
  console.log(`[bolt] question ${matched.id} answered via thread reply by ${event.user}`);

  const devSlackId = process.env.DEVELOPER_SLACK_ID;
  if (devSlackId && devSlackId !== event.user) {
    await client.chat.postMessage({
      channel: devSlackId,
      text: `✅ *Decision captured* — <@${event.user}> answered in Slack.\n\n*Q:* ${matched.text}\n*A:* ${event.text}\n\n_Resume your Claude session with: "the Slack answers are in — continue with the task"_`,
    }).catch((e: unknown) => console.error("[bolt] DM failed:", e));
  }

  // Update the question message to show answered state
  if (matched.slackChannel && matched.slackMessageTs) {
    await client.chat.update({
      channel: matched.slackChannel,
      ts: matched.slackMessageTs,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: buildAnsweredQuestionBlocks({
        questionText: matched.text,
        category: matched.category,
        riskLevel: matched.riskLevel,
        reviewerSlackId: event.user,
        answer: event.text,
      }) as any,
      text: `✅ Answered — ${matched.text}`,
    }).catch((e: unknown) => console.error("[bolt] update failed:", e));
  }

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.thread_ts,
    text: `✅ Saved. Thank you <@${event.user}>! _Reply to each remaining question in this thread._`,
  });
});

// ── Modal submit: "answer_question_modal" (with rationale) ────────────────────
boltApp.view("answer_question_modal", async ({ ack, body, view, client }) => {
  await ack();

  const { questionId, suggestedEntryType } = JSON.parse(view.private_metadata) as { questionId: string; suggestedEntryType: string };
  const entryType = view.state.values["entry_type_block"]?.["entry_type_input"]?.selected_option?.value ?? suggestedEntryType ?? "decision";
  const answer = view.state.values["answer_block"]?.["answer_input"]?.value ?? "";
  const rationale = view.state.values["rationale_block"]?.["rationale_input"]?.value ?? null;
  const alternatives = view.state.values["alternatives_block"]?.["alternatives_input"]?.value ?? null;
  const reopenCondition = view.state.values["reopen_block"]?.["reopen_input"]?.value ?? null;
  const supersedesId = view.state.values["supersedes_block"]?.["supersedes_input"]?.value ?? null;
  const reviewerSlackId = body.user.id;

  try {
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { prompt: true },
    });
    if (!question) {
      console.error(`[bolt] modal submit: question ${questionId} not found`);
      return;
    }

    // Validate rollback entries must reference a valid prior decision
    if (entryType === "rollback" && !supersedesId) {
      console.error(`[bolt] modal submit: rollback entry requires supersedes_id`);
      return;
    }
    if (supersedesId) {
      const target = await prisma.decision.findUnique({ where: { id: supersedesId } });
      if (!target) {
        console.error(`[bolt] modal submit: supersedes_id ${supersedesId} does not match any existing decision`);
        return;
      }
    }

    const existing = await prisma.decision.findUnique({ where: { questionId } });
    await prisma.question.update({ where: { id: questionId }, data: { status: "resolved" } });
    if (!existing) {
      const hexId = Math.random().toString(16).slice(2, 9);
      const repoId = question.prompt.repoPath
        ? await upsertRepo(question.prompt.repoPath).catch(() => null)
        : null;
      await prisma.decision.create({
        data: {
          hexId,
          entryType,
          questionId,
          questionText: question.text,
          answer,
          rationale: rationale ?? null,
          alternativesConsidered: alternatives ?? null,
          reopenCondition: reopenCondition ?? null,
          supersededById: supersedesId ?? null,
          reviewerSlackId,
          linkedRepo: question.prompt.repoPath ?? null,
          repoId: repoId ?? null,
          linkedFiles: question.prompt.openFilePath ? [question.prompt.openFilePath] : [],
          reasoningArc: null,  // modal is fast-path — no dialogue arc; Phase 2 sessions will populate this
        },
      });
    }

    embedDecision(questionId).catch((e) => console.error("[bolt] embed failed:", e));

    // DM the developer
    const devSlackId = process.env.DEVELOPER_SLACK_ID;
    if (devSlackId && devSlackId !== reviewerSlackId) {
      await client.chat.postMessage({
        channel: devSlackId,
        text: `✅ *Entry captured* (\`${entryType}\`) — <@${reviewerSlackId}> answered a question in your project.\n\n*Q:* ${question.text}\n*A:* ${answer}${rationale ? `\n*Rationale:* ${rationale}` : ""}${alternatives ? `\n*Alternatives:* ${alternatives}` : ""}${reopenCondition ? `\n*Revisit if:* ${reopenCondition}` : ""}\n\nRun \`/decide-log\` in your repo to commit it.`,
      }).catch((e) => console.error("[bolt] DM failed:", e));
    }

    // Update the original question message to answered state
    if (question.slackChannel && question.slackMessageTs) {
      await client.chat.update({
        channel: question.slackChannel,
        ts: question.slackMessageTs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: buildAnsweredQuestionBlocks({
          questionText: question.text,
          category: question.category,
          riskLevel: question.riskLevel,
          reviewerSlackId,
          answer,
          rationale,
        }) as any,
        text: `✅ Answered — ${question.text}`,
      });
    }

    console.log(`[bolt] question ${questionId} answered via modal by ${reviewerSlackId}`);
  } catch (err) {
    console.error("[bolt] modal submit error:", err);
  }
});

// ── postQuestionToSlack ────────────────────────────────────────────────────────
// Posts a single question as a thread reply to an existing session message.
// If sessionTs is not provided, posts a new top-level session message first.
export async function postQuestionToSlack(params: {
  questionId: string;
  questionText: string;
  promptContent: string;
  repoPath: string | null;
  category: string | null;
  riskLevel: string;
  reviewerSlackId: string;
  developerSlackId?: string | null;
  sessionTs?: string;        // ts of the session thread parent; create one if absent
  questionNumber?: number;
  totalQuestions?: number;
}): Promise<{ ts: string; channel: string; sessionTs: string }> {
  const channel = process.env.SLACK_ESCALATION_CHANNEL ?? "";
  if (!channel) throw new Error("SLACK_ESCALATION_CHANNEL is not set");

  let sessionTs = params.sessionTs;

  // First question in a batch: create the session header message
  if (!sessionTs) {
    const session = await boltApp.client.chat.postMessage({
      channel,
      text: `<@${params.reviewerSlackId}> — ${params.totalQuestions ?? 1} decision${(params.totalQuestions ?? 1) > 1 ? "s" : ""} needed`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: buildSessionBlocks({
        reviewerSlackId: params.reviewerSlackId,
        developerSlackId: params.developerSlackId,
        promptContent: params.promptContent,
        repoPath: params.repoPath,
        questionCount: params.totalQuestions ?? 1,
        highestRisk: params.riskLevel,
      }) as any,
    });
    if (!session.ok || !session.ts) throw new Error(`Slack session post failed: ${session.error}`);
    sessionTs = session.ts;
  }

  // Post each question as a reply in the session thread
  const result = await boltApp.client.chat.postMessage({
    channel,
    thread_ts: sessionTs,
    text: `Q${params.questionNumber ?? 1}: ${params.questionText}`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: buildQuestionBlocks(params) as any,
  });

  if (!result.ok || !result.ts) {
    throw new Error(`Slack question post failed: ${result.error ?? "unknown error"}`);
  }

  console.log(`[bolt] posted question ${params.questionId} as thread reply ts=${result.ts} session=${sessionTs}`);
  return { ts: result.ts, channel, sessionTs };
}

