/*
  Warnings:

  - You are about to drop the column `reasoning_arc` on the `decisions` table. All the data in the column will be lost.
  - You are about to drop the column `session_id` on the `decisions` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "artifact_decision_links_decisionId_idx";

-- DropIndex
DROP INDEX "decisions_repoId_idx";

-- DropIndex
DROP INDEX "prompts_repoId_idx";

-- DropIndex
DROP INDEX "tracked_artifacts_repoId_idx";

-- AlterTable
ALTER TABLE "decisions" DROP COLUMN "reasoning_arc",
DROP COLUMN "session_id",
ADD COLUMN     "reasoningArc" TEXT,
ADD COLUMN     "sessionId" TEXT,
ALTER COLUMN "decision_number" SET DEFAULT nextval('decision_number_seq'::regclass),
ALTER COLUMN "decision_number" DROP DEFAULT;
DROP SEQUENCE "decision_number_seq";

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

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "refining_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refining_sessions" ADD CONSTRAINT "refining_sessions_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refining_sessions" ADD CONSTRAINT "refining_sessions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "refining_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
