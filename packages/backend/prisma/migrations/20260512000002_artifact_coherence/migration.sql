-- Phase 3: Artifact Coherence
-- tracked_artifacts: files in a repo governed by WAL decisions
-- artifact_decision_links: M2M between tracked files and decisions

CREATE TABLE "tracked_artifacts" (
  "id"          TEXT NOT NULL,
  "repoId"      TEXT NOT NULL,
  "filePath"    TEXT NOT NULL,
  "description" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tracked_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "tracked_artifacts_repoId_filePath_key" UNIQUE ("repoId", "filePath"),
  CONSTRAINT "tracked_artifacts_repoId_fkey" FOREIGN KEY ("repoId")
    REFERENCES "repos"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "artifact_decision_links" (
  "artifactId"  TEXT NOT NULL,
  "decisionId"  TEXT NOT NULL,

  CONSTRAINT "artifact_decision_links_pkey" PRIMARY KEY ("artifactId", "decisionId"),
  CONSTRAINT "artifact_decision_links_artifactId_fkey" FOREIGN KEY ("artifactId")
    REFERENCES "tracked_artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "artifact_decision_links_decisionId_fkey" FOREIGN KEY ("decisionId")
    REFERENCES "decisions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "tracked_artifacts_repoId_idx" ON "tracked_artifacts"("repoId");
CREATE INDEX "artifact_decision_links_decisionId_idx" ON "artifact_decision_links"("decisionId");
