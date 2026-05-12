-- Phase 1: WAL Upgrade
-- Adds reasoningArc (the dialogue context that led to a decision) and
-- sessionId (FK placeholder for Phase 2 RefiningSession) to the decisions table.

ALTER TABLE "decisions" ADD COLUMN "reasoning_arc" TEXT;
ALTER TABLE "decisions" ADD COLUMN "session_id" TEXT;
