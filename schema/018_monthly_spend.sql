-- Frank D1 Schema - migration 018
-- Race-free monthly spend counter (CP-375).
--
-- The KV cost:YYYY-MM counter was read, added to, and written back. Two runs
-- that finished at the same time could both read the old total, so one cost
-- was lost and the budget cap could be passed. KV has no atomic add.
--
-- incrementMonthlyCost now adds each cost with one upsert on this table
-- (INSERT ... ON CONFLICT DO UPDATE SET total_usd = total_usd + excluded).
-- D1 runs writes one at a time, so no add is lost. The KV key stays as a cache
-- of this total for the fast path and the metrics page.
--
-- month       'YYYY-MM' in UTC, the same key the KV counter uses.
-- total_usd   Every recorded cost for the month: research, verification, chat.
-- updated_at  Unix epoch seconds of the last add.
CREATE TABLE IF NOT EXISTS monthly_spend (
    month TEXT PRIMARY KEY,
    total_usd REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
