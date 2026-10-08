-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "tracked" BOOLEAN NOT NULL DEFAULT true;

-- Backfill: a PR referenced by a kill claim that has no mutants and no run
-- requests was only synced to check the claim. Untrack it; syncing it again
-- from the UI, the webhook or a run request tracks it.
UPDATE "PullRequest" p
SET "tracked" = false
WHERE EXISTS (SELECT 1 FROM "KillClaim" k WHERE k."pullRequestId" = p.id)
  AND NOT EXISTS (SELECT 1 FROM "Mutant" m WHERE m."pullRequestId" = p.id)
  AND NOT EXISTS (
    SELECT 1 FROM "Mutant" m JOIN "Revision" r ON r.id = m."revisionId"
    WHERE r."pullRequestId" = p.id
  )
  AND NOT EXISTS (SELECT 1 FROM "RunRequest" q WHERE q."pullRequestId" = p.id);
