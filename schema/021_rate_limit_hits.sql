-- Frank D1 Schema - migration 021 (CP-808)
-- Atomic sliding-window rate limiter. worker/lib/rate-limit.js inserts one row per
-- allowed hit with a single conditional INSERT (only while the bucket holds fewer
-- than the limit inside the window). D1 has one primary, so a parallel burst from
-- any number of colos can never pass more than the limit. Blocked hits are not
-- stored, so a bucket never holds more rows than its limit. The cron prunes rows
-- past expires_at (worker/jobs.js).
-- Until this runs, the limiter falls back to the old KV window (logged once per call).
--
-- Undo:
--   DROP TABLE rate_limit_hits;

CREATE TABLE IF NOT EXISTS rate_limit_hits (
    bucket TEXT NOT NULL,          -- "ratelimit:<prefix>:<hashed ip>" or a site-wide key
    ts INTEGER NOT NULL,           -- hit time, ms since epoch
    expires_at INTEGER NOT NULL    -- ts + window, ms; the cron deletes past this
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_bucket_ts ON rate_limit_hits(bucket, ts);
CREATE INDEX IF NOT EXISTS idx_rate_limit_hits_expires ON rate_limit_hits(expires_at);
