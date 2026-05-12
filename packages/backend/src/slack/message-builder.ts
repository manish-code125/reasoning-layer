// Block Kit builders — all Slack message/modal shapes are here, testable in isolation.

const RISK_EMOJI: Record<string, string> = {
  low: "🟢",
  medium: "🟡",
  high: "🟠",
  critical: "🔴",
};

// Top-level session message — posted once per routing batch, questions follow as thread replies.
export function buildSessionBlocks(params: {
  reviewerSlackId: string;
  developerSlackId?: string | null;
  promptContent: string;
  repoPath: string | null;
  questionCount: number;
  highestRisk: string;
}): object[] {
  const emoji = RISK_EMOJI[params.highestRisk] ?? "⚪";
  const preview =
    params.promptContent.length > 250
      ? params.promptContent.slice(0, 250) + "…"
      : params.promptContent;

  const fields: object[] = [
    { type: "mrkdwn", text: `*For:* <@${params.reviewerSlackId}>` },
    { type: "mrkdwn", text: `*Questions:* ${params.questionCount}` },
    { type: "mrkdwn", text: `*Highest risk:* ${emoji} \`${params.highestRisk}\`` },
  ];
  if (params.repoPath) fields.push({ type: "mrkdwn", text: `*Repo:* \`${params.repoPath}\`` });
  if (params.developerSlackId) fields.push({ type: "mrkdwn", text: `*From:* <@${params.developerSlackId}>` });

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `${emoji} ${params.questionCount} decision${params.questionCount > 1 ? "s" : ""} needed from <@${params.reviewerSlackId}>`, emoji: true },
    },
    { type: "section", fields },
    { type: "section", text: { type: "mrkdwn", text: `*Request:*\n> ${preview}` } },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `↓ Each question is a thread reply below — answer each one individually` }],
    },
  ];
}

// Individual question — posted as a thread reply to the session message.
export function buildQuestionBlocks(params: {
  questionId: string;
  questionText: string;
  promptContent: string;
  repoPath: string | null;
  category: string | null;
  riskLevel: string;
  reviewerSlackId: string;
  developerSlackId?: string | null;
  questionNumber?: number;
  totalQuestions?: number;
}): object[] {
  const emoji = RISK_EMOJI[params.riskLevel] ?? "⚪";
  const numLabel = params.questionNumber && params.totalQuestions
    ? `Q${params.questionNumber} of ${params.totalQuestions} · `
    : "";

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${emoji} ${numLabel}${params.category ?? "general"}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*❓ ${params.questionText}*` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Risk: ${emoji} \`${params.riskLevel}\` · 💬 Reply here to answer, or click the button for structured entry` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "✏️  Answer with rationale", emoji: true },
          action_id: "answer_question",
          value: params.questionId,
        },
      ],
    },
  ];
}

export function buildAnsweredQuestionBlocks(params: {
  questionText: string;
  category: string | null;
  riskLevel: string;
  reviewerSlackId: string;
  answer: string;
  rationale?: string | null;
}): object[] {
  const emoji = RISK_EMOJI[params.riskLevel] ?? "⚪";
  const preview = params.answer.length > 300 ? params.answer.slice(0, 297) + "…" : params.answer;

  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `✅ Answered — ${params.category ?? "general"}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Answered by:* <@${params.reviewerSlackId}>` },
        { type: "mrkdwn", text: `*Risk:* ${emoji} \`${params.riskLevel}\`` },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*❓ ${params.questionText}*` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Decision:*\n> ${preview}` },
    },
    ...(params.rationale
      ? [{ type: "section", text: { type: "mrkdwn", text: `*Rationale:* ${params.rationale}` } }]
      : []),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `_Stored as a reusable architectural decision_` }],
    },
  ];
}

// One message per reviewer containing all their assigned questions.
// Each question gets its own Answer button. Answered questions show a checkmark + answer preview.
// This function is also called on message update (after each answer) to reflect current state.
export function buildGroupedQuestionsBlocks(params: {
  reviewerSlackId: string;
  developerSlackId?: string | null;
  promptContent: string;
  repoPath: string | null;
  questions: Array<{
    questionId: string;
    questionText: string;
    category: string | null;
    riskLevel: string;
    answered?: boolean;
    answerPreview?: string | null;
  }>;
}): object[] {
  const promptPreview =
    params.promptContent.length > 200
      ? params.promptContent.slice(0, 200) + "…"
      : params.promptContent;

  const answeredCount = params.questions.filter((q) => q.answered).length;
  const total = params.questions.length;

  const highestRisk = params.questions.reduce((best, q) => {
    const order = ["low", "medium", "high", "critical"];
    return order.indexOf(q.riskLevel) > order.indexOf(best) ? q.riskLevel : best;
  }, "low");

  const progressBar = `${"✅".repeat(answeredCount)}${"⬜".repeat(total - answeredCount)} ${answeredCount}/${total} answered`;

  const metaFields: object[] = [
    { type: "mrkdwn", text: `*Reviewer:* <@${params.reviewerSlackId}>` },
    { type: "mrkdwn", text: `*Progress:* ${progressBar}` },
    { type: "mrkdwn", text: `*Highest risk:* \`${highestRisk}\`` },
  ];
  if (params.repoPath) {
    metaFields.push({ type: "mrkdwn", text: `*Repo:* \`${params.repoPath}\`` });
  }
  if (params.developerSlackId) {
    metaFields.push({ type: "mrkdwn", text: `*From:* <@${params.developerSlackId}>` });
  }

  const blocks: object[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `${RISK_EMOJI[highestRisk] ?? "⚪"} Clarification needed — ${total} question${total > 1 ? "s" : ""} for you`,
        emoji: true,
      },
    },
    { type: "section", fields: metaFields },
    { type: "section", text: { type: "mrkdwn", text: `*Original prompt:*\n> ${promptPreview}` } },
    { type: "divider" },
  ];

  for (const q of params.questions) {
    const riskEmoji = RISK_EMOJI[q.riskLevel] ?? "⚪";

    if (q.answered) {
      // Answered: show checkmark + truncated answer preview, no button
      const preview = q.answerPreview
        ? (q.answerPreview.length > 120 ? q.answerPreview.slice(0, 117) + "…" : q.answerPreview)
        : "*(answer recorded)*";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ ~${riskEmoji} *[${q.riskLevel}]* ${q.questionText}~\n> ${preview}`,
        },
      });
    } else {
      // Pending: show question with Answer button
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${riskEmoji} *[${q.riskLevel}]* ${q.questionText}` },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "✏️  Answer", emoji: true },
          style: "primary",
          action_id: "answer_question",
          value: q.questionId,
        },
      });
    }
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: "_Answers are stored as reusable architectural decisions_" }],
  });

  return blocks;
}

const ENTRY_TYPE_OPTIONS = [
  { text: { type: "plain_text", text: "✅ Decision — settled answer" }, value: "decision" },
  { text: { type: "plain_text", text: "🚫 Won't Do — explicit rejection" }, value: "wont_do" },
  { text: { type: "plain_text", text: "🅿 Tabled — valid but deferred" }, value: "table" },
  { text: { type: "plain_text", text: "🌿 Branch — needs decomposition" }, value: "branch" },
  { text: { type: "plain_text", text: "↩ Rollback — supersedes a prior entry" }, value: "rollback" },
  { text: { type: "plain_text", text: "👁 Observation — note, no decision needed" }, value: "observation" },
];

export function buildAnswerModal(
  questionId: string,
  questionText: string,
  suggestedEntryType: string = "decision",
): object {
  const initialOption = ENTRY_TYPE_OPTIONS.find((o) => o.value === suggestedEntryType)
    ?? ENTRY_TYPE_OPTIONS[0];

  return {
    type: "modal",
    callback_id: "answer_question_modal",
    // JSON payload so the submit handler gets both questionId and suggestedEntryType
    private_metadata: JSON.stringify({ questionId, suggestedEntryType }),
    title: { type: "plain_text", text: "Record Decision", emoji: true },
    submit: { type: "plain_text", text: "Save Entry", emoji: true },
    close: { type: "plain_text", text: "Cancel", emoji: true },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Question:*\n${questionText}` },
      },
      { type: "divider" },
      {
        type: "input",
        block_id: "entry_type_block",
        label: { type: "plain_text", text: "Entry type", emoji: true },
        element: {
          type: "static_select",
          action_id: "entry_type_input",
          initial_option: initialOption,
          options: ENTRY_TYPE_OPTIONS,
        },
      },
      {
        type: "input",
        block_id: "answer_block",
        label: { type: "plain_text", text: "Your answer", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "answer_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Be specific — this will be stored as a reusable architectural decision…",
          },
        },
      },
      {
        type: "input",
        block_id: "rationale_block",
        optional: true,
        label: { type: "plain_text", text: "Rationale", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "rationale_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "Why this approach?",
          },
        },
      },
      {
        type: "input",
        block_id: "alternatives_block",
        optional: true,
        label: { type: "plain_text", text: "Alternatives considered", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "alternatives_input",
          multiline: true,
          placeholder: {
            type: "plain_text",
            text: "What other approaches did you weigh before settling on this?",
          },
        },
      },
      {
        type: "input",
        block_id: "reopen_block",
        optional: true,
        label: { type: "plain_text", text: "Revisit if…", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "reopen_input",
          placeholder: {
            type: "plain_text",
            text: "Under what conditions should this be reconsidered? (e.g. 'if we add multi-tenancy')",
          },
        },
      },
      {
        type: "input",
        block_id: "supersedes_block",
        optional: true,
        label: { type: "plain_text", text: "Supersedes decision ID (rollback only)", emoji: true },
        element: {
          type: "plain_text_input",
          action_id: "supersedes_input",
          placeholder: {
            type: "plain_text",
            text: "UUID of the decision this entry supersedes",
          },
        },
      },
    ],
  };
}
