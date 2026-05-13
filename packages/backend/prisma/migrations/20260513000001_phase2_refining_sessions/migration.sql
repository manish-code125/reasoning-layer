-- Phase 2: Async Refining Session
-- Adds RefiningSession and SessionMessage models.
-- Adds FK constraint on decisions.session_id → refining_sessions.id.
-- The reasoning_arc and session_id columns already exist from Phase 1 (WAL upgrade).

-- CreateTable
CREATE TABLE "refining_sessions" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "questionId" TEXT,
    "topic" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "outcome" TEXT,
    "interimDecisionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "refining_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_messages" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "slackTs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refining_sessions_questionId_key" ON "refining_sessions"("questionId");

-- AddForeignKey: decisions.session_id → refining_sessions.id
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "refining_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: refining_sessions.promptId → prompts.id
ALTER TABLE "refining_sessions" ADD CONSTRAINT "refining_sessions_promptId_fkey"
    FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: refining_sessions.questionId → questions.id
ALTER TABLE "refining_sessions" ADD CONSTRAINT "refining_sessions_questionId_fkey"
    FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: session_messages.sessionId → refining_sessions.id
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "refining_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
