-- Stoa entry types migration
-- Adds: entryType, hexId (with backfill), reopenCondition, supersededById to decisions
-- Adds: suggestedEntryType to questions

-- questions: LLM-hinted entry type per generated question
ALTER TABLE "questions" ADD COLUMN "suggestedEntryType" TEXT;

-- decisions: Stoa entry type (default 'decision' preserves all existing rows)
ALTER TABLE "decisions" ADD COLUMN "entryType" TEXT NOT NULL DEFAULT 'decision';

-- decisions: reopenCondition — when should this be revisited?
ALTER TABLE "decisions" ADD COLUMN "reopenCondition" TEXT;

-- decisions: hexId — add as nullable, backfill, then enforce NOT NULL + UNIQUE
ALTER TABLE "decisions" ADD COLUMN "hexId" TEXT;
UPDATE "decisions" SET "hexId" = SUBSTR(MD5("id"::TEXT), 1, 7);
ALTER TABLE "decisions" ALTER COLUMN "hexId" SET NOT NULL;
CREATE UNIQUE INDEX "decisions_hexId_key" ON "decisions"("hexId");

-- decisions: supersededById — self-referential FK for rollback entries
ALTER TABLE "decisions" ADD COLUMN "supersededById" TEXT;
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_supersededById_fkey"
  FOREIGN KEY ("supersededById") REFERENCES "decisions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
