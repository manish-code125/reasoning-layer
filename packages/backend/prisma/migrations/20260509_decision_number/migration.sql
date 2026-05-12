-- Create a permanent sequence for immutable decision numbering (ADR-001, ADR-002, ...)
CREATE SEQUENCE IF NOT EXISTS decision_number_seq START 1;

-- Add the decision_number column, defaulting to the next sequence value
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS decision_number INTEGER NOT NULL DEFAULT nextval('decision_number_seq');

-- Backfill existing decisions in chronological order so they get stable numbers
WITH numbered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) AS rn FROM decisions
)
UPDATE decisions SET decision_number = numbered.rn FROM numbered WHERE decisions.id = numbered.id;

-- Reset the sequence to continue after the highest existing number
SELECT setval('decision_number_seq', COALESCE((SELECT MAX(decision_number) FROM decisions), 0) + 1, false);

-- Unique constraint — each decision has exactly one immutable number
ALTER TABLE decisions ADD CONSTRAINT decisions_decision_number_key UNIQUE (decision_number);

-- Remove updatedAt since decisions are now immutable (no updates allowed)
ALTER TABLE decisions DROP COLUMN IF EXISTS "updatedAt";
