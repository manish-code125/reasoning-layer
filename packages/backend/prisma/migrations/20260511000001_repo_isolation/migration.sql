-- Repo isolation migration
-- Adds a repos table as the canonical unit of isolation.
-- Backfills repoId FK from existing repoPath/linkedRepo strings.
-- Old string columns are kept for backwards compat but repoId is the preferred filter.

-- 1. Create repos table
CREATE TABLE "repos" (
  "id"        TEXT NOT NULL,
  "path"      TEXT NOT NULL,
  "name"      TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "repos_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "repos_path_key" ON "repos"("path");

-- 2. Backfill distinct repo paths from prompts
INSERT INTO "repos" ("id", "path", "createdAt")
SELECT gen_random_uuid()::TEXT, t."repoPath", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "repoPath" FROM "prompts" WHERE "repoPath" IS NOT NULL) t
ON CONFLICT ("path") DO NOTHING;

-- 3. Backfill distinct repo paths from decisions
INSERT INTO "repos" ("id", "path", "createdAt")
SELECT gen_random_uuid()::TEXT, t."linkedRepo", CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "linkedRepo" FROM "decisions" WHERE "linkedRepo" IS NOT NULL) t
ON CONFLICT ("path") DO NOTHING;

-- 4. Add repoId FK to prompts
ALTER TABLE "prompts" ADD COLUMN "repoId" TEXT;
ALTER TABLE "prompts"
  ADD CONSTRAINT "prompts_repoId_fkey"
  FOREIGN KEY ("repoId") REFERENCES "repos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "prompts_repoId_idx" ON "prompts"("repoId");

-- 5. Backfill prompts.repoId from repoPath
UPDATE "prompts" p
SET "repoId" = r."id"
FROM "repos" r
WHERE p."repoPath" = r."path";

-- 6. Add repoId FK to decisions
ALTER TABLE "decisions" ADD COLUMN "repoId" TEXT;
ALTER TABLE "decisions"
  ADD CONSTRAINT "decisions_repoId_fkey"
  FOREIGN KEY ("repoId") REFERENCES "repos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "decisions_repoId_idx" ON "decisions"("repoId");

-- 7. Backfill decisions.repoId from linkedRepo
UPDATE "decisions" d
SET "repoId" = r."id"
FROM "repos" r
WHERE d."linkedRepo" = r."path";
