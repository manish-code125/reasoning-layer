-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "prompts" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "repoPath" TEXT,
    "openFilePath" TEXT,
    "language" TEXT,
    "fileTree" JSONB,
    "readmeSnippet" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "analysis" JSONB,
    "enrichedPrompt" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prompts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "questions" (
    "id" TEXT NOT NULL,
    "promptId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT,
    "riskLevel" TEXT NOT NULL DEFAULT 'medium',
    "status" TEXT NOT NULL DEFAULT 'unanswered',
    "localAnswer" TEXT,
    "slackRouted" BOOLEAN NOT NULL DEFAULT false,
    "slackMessageTs" TEXT,
    "slackChannel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "questionId" TEXT,
    "questionText" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "alternativesConsidered" TEXT,
    "rationale" TEXT,
    "reviewerSlackId" TEXT,
    "linkedFiles" TEXT[],
    "linkedRepo" TEXT,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "decisions_questionId_key" ON "decisions"("questionId");

-- AddForeignKey
ALTER TABLE "questions" ADD CONSTRAINT "questions_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "prompts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "questions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
