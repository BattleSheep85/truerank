-- Frank D1 Schema - migration 024 (CP-352)
-- Readers answer "Does this match what you found?" on a report page. Each
-- visitor (salted IP hash) has one vote per report: a second vote replaces
-- the first. When DISAGREE_THRESHOLD different visitors say "No" inside 14
-- days, the server starts one fresh run (worker/lib/disagreement.js).
-- disagreement_reruns records that run, so a report gets at most one per
-- 14 days. Old feedback rows keep voter_hash NULL and never count.
--
-- Undo:
--   DROP TABLE disagreement_reruns;
--   DROP INDEX idx_feedback_voter;
--   ALTER TABLE feedback DROP COLUMN voter_hash;

ALTER TABLE feedback ADD COLUMN voter_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_voter ON feedback(report_id, voter_hash);

CREATE TABLE IF NOT EXISTS disagreement_reruns (
  report_id TEXT PRIMARY KEY,
  rerun_id TEXT,
  created_at INTEGER NOT NULL
);
