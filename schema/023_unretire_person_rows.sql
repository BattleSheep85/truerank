-- Frank D1 Schema - migration 023 (CP-341)
-- Bring back reports that migration 017 retired although a person made them.
--
-- 017 retires a row when a keyword with the same text links to it. That also
-- matches a row an anonymous person made, when a keyword later clustered onto
-- it. research has no column that records who made a row, but the time does:
-- runFlywheelTick runs only from the cron (wrangler.toml, "*/10 * * * *"), so
-- every row it inserts is created in the first minute or so after a 10-minute
-- mark. In production (2026-10-20) 361 of the 362 retired rows were created
-- 1 to 68 seconds after a mark. The one other row (390 seconds after) is a
-- person's "best espresso machine under $500" page that two keywords clustered
-- onto days later.
--
-- Rule: un-retire a 'seo-flywheel' row created 120 seconds or more after a
-- 10-minute mark. The cron cannot have inserted it. A second run changes
-- nothing. A person's row created inside the window stays retired; the
-- chance is about 1 in 5 per row, and production had one such row at most.
--
-- Undo:
--   UPDATE research SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'seo-flywheel'
--    WHERE slug = 'best-espresso-machine-under-500-0u5d4e3k'

UPDATE research
   SET retired_at = NULL, retired_reason = NULL
 WHERE retired_reason = 'seo-flywheel'
   AND created_at % 600 >= 120;
