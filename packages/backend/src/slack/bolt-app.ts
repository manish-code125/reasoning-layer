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
// Phase 2 async model: replies accumulate as SessionMessage turns.
// Settling requires an explicit prefix: /settle, /table, or /wont-do.
// Until settled, no WAL entry is written — developer already has an interim table entry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
boltApp.event("message", async ({ event, client }: any) => {
  // Only thread replies; ignore top-level posts, bot messages, edits, deletes
  if (!event.thread_ts || event.thread_ts === event.ts) return;
  if (event.subtype) return;
  if (event.bot_id) return;
  if (!event.text?.trim()) return;

  console.log(`[bolt] thread reply: channel=${event.channel} thread_ts=${event.thread_ts} ts=${event.ts} user=${event.user}`);

  const question = await prisma.question.findFirst({
    where: {
      slackMessageTs: event.thread_ts,
      slackChannel: event.channel,
      status: { notIn: ["resolved", "answered_locally"] },
    },
    include: {
      prompt: true,
      refiningSession: {
        include: { messages: { orderBy: { createdAt: "asc" } } },
      },
    },
  });

  if (!question) {
    console.log(`[bolt] no open question found for thread_ts=${event.thread_ts} channel=${event.channel}`);
    return;
  }

  const text: string = event.text.trim();
  const settleMatch = /^\/settle\s+(.+)/is.exec(text);
  const tableMatch = /^\/table(?:\s+(.*))?/is.exec(text);
  const wontDoMatch = /^\/wont-do\s+(.+)/is.exec(text);

  // ── Settlement ────────────────────────────────────────────────────────────────
  if (settleMatch || wontDoMatch) {
    const answerText = (settleMatch?.[1] ?? wontDoMatch?.[1] ?? "").trim();
    const entryType = wontDoMatch ? "wont_do" : "decision";

    // If there's already a final decision (not interim), skip
    const allDecisions = await prisma.decision.findMany({ where: { questionId: question.id } });
    const finalDecision = allDecisions.find((d) => d.entryType !== "table");
    if (finalDecision) {
      console.log(`[bolt] question ${question.id} already settled — ignoring`);
      return;
    }

    const session = question.refiningSession;

    // Add this settle message to the session (if session exists)
    if (session) {
      await prisma.sessionMessage.create({
        data: { sessionId: session.id, role: "reviewer", content: text, slackTs: event.ts },
      });
    }

    const repoId = question.prompt.repoPath
      ? await upsertRepo(question.prompt.repoPath).catch(() => null)
      : question.prompt.repoId ?? null;

    const allMessages = session
      ? [...session.messages, { role: "reviewer", content: text, createdAt: new Date() }]
      : [];
    const reasoningArc = allMessages.length > 0
      ? allMessages.map((m) => `${m.role}: ${m.content}`).join("\n")
      : null;

    const hexId = Math.random().toString(16).slice(2, 9);
    const decision = await prisma.decision.create({
      data: {
        hexId,
        entryType,
        questionId: question.id,
        questionText: question.text,
        answer: answerText,
        rationale: null,
        reviewerSlackId: event.user,
        linkedRepo: question.prompt.repoPath ?? null,
        repoId: repoId ?? null,
        linkedFiles: question.prompt.openFilePath ? [question.prompt.openFilePath] : [],
        reasoningArc,
        sessionId: session?.id ?? null,
        supersededById: session?.interimDecisionId ?? null,
      },
    });

    await prisma.question.update({ where: { id: question.id }, data: { status: "resolved" } });
    if (session) {
      await prisma.refiningSession.update({
        where: { id: session.id },
        data: { status: "settled", outcome: entryType, settledAt: new Date() },
      });
    }

    embedDecision(decision.id).catch((e: unknown) => console.error("[bolt] embed failed:", e));
    console.log(`[bolt] question ${question.id} settled (${entryType}) by ${event.user}`);

    // FYI DM — not a gate; developer's next session catches this up automatically
    const devSlackId = process.env.DEVELOPER_SLACK_ID;
    if (devSlackId && devSlackId !== event.user) {
      await client.chat.postMessage({
        channel: devSlackId,
        text: `✅ *Decision landed* (\`${entryType}\`) — <@${event.user}> settled a question.\n\n*Q:* ${question.text}\n*A:* ${answerText}\n\n_Your next session will pick this up automatically via the catch-up cadence._`,
      }).catch((e: unknown) => console.error("[bolt] DM failed:", e));
    }

    // Update the question message to settled state
    if (question.slackChannel && question.slackMessageTs) {
      await client.chat.update({
        channel: question.slackChannel,
        ts: question.slackMessageTs,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        blocks: buildAnsweredQuestionBlocks({
          questionText: question.text,
          category: question.category,
          riskLevel: question.riskLevel,
          reviewerSlackId: event.user,
          answer: answerText,
        }) as any,
        text: `✅ Settled — ${question.text}`,
      }).catch((e: unknown) => console.error("[bolt] update failed:", e));
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `✅ Settled. Decision recorded — \`${hexId}\`.`,
    });
    return;
  }

  // ── Explicit /table ───────────────────────────────────────────────────────────
  if (tableMatch) {
    const rationale = tableMatch[1]?.trim() || "Explicitly tabled.";
    const session = question.refiningSession;

    if (session) {
      await prisma.sessionMessage.create({
        data: { sessionId: session.id, role: "reviewer", content: text, slackTs: event.ts },
      });
      if (session.interimDecisionId) {
        await prisma.decision.update({
          where: { id: session.interimDecisionId },
          data: { rationale },
        });
      }
      await prisma.refiningSession.update({
        where: { id: session.id },
        data: { status: "tabled", outcome: "table", settledAt: new Date() },
      });
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `📋 Tabled. The interim assumption stays in place — revisit when ready.`,
    });
    return;
  }

  // ── Plain reply — accumulate as SessionMessage ────────────────────────────────
  const session = question.refiningSession;
  if (session) {
    await prisma.sessionMessage.create({
      data: { sessionId: session.id, role: "reviewer", content: text, slackTs: event.ts },
    });
    console.log(`[bolt] turn added to session ${session.id} by ${event.user}`);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `Got it. Keep discussing, or use \`/settle <answer>\`, \`/table\`, or \`/wont-do <reason>\` to close this question.`,
    });
  } else {
    // No session — fast-path legacy behavior (shouldn't happen after Phase 2, but safe fallback)
    const existing = await prisma.decision.findUnique({ where: { questionId: question.id } });
    if (existing) return;

    const hexId = Math.random().toString(16).slice(2, 9);
    const repoId = question.prompt.repoPath ? await upsertRepo(question.prompt.repoPath).catch(() => null) : null;

    await prisma.question.update({ where: { id: question.id }, data: { status: "resolved" } });
    const decision = await prisma.decision.create({
      data: {
        hexId, entryType: "decision", questionId: question.id, questionText: question.text,
        answer: text, reviewerSlackId: event.user,
        linkedRepo: question.prompt.repoPath ?? null, repoId: repoId ?? null,
        linkedFiles: question.prompt.openFilePath ? [question.prompt.openFilePath] : [],
        reasoningArc: null,
      },
    });
    embedDecision(decision.id).catch((e: unknown) => console.error("[bolt] embed failed:", e));

    const devSlackId = process.env.DEVELOPER_SLACK_ID;
    if (devSlackId && devSlackId !== event.user) {
      await client.chat.postMessage({
        channel: devSlackId,
        text: `✅ *Decision landed* — <@${event.user}> answered.\n\n*Q:* ${question.text}\n*A:* ${text}\n\n_Your next session will pick this up automatically._`,
      }).catch((e: unknown) => console.error("[bolt] DM failed:", e));
    }

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts,
      text: `✅ Saved. Thank you <@${event.user}>!`,
    });
  }
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
        text: `✅ *Decision landed* (\`${entryType}\`) — <@${reviewerSlackId}> answered a question.\n\n*Q:* ${question.text}\n*A:* ${answer}${rationale ? `\n*Rationale:* ${rationale}` : ""}${alternatives ? `\n*Alternatives:* ${alternatives}` : ""}${reopenCondition ? `\n*Revisit if:* ${reopenCondition}` : ""}\n\n_Your next session will pick this up automatically via the catch-up cadence._`,
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

