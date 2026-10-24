-- Frank D1 Schema - migration 019 (CP-803)
-- Retire research rows whose query is a SQL-injection scanner probe. The queries were
-- parameterized, so nothing ran, but five probes from 2026-06-13 became public pages
-- ("Best Tax Software for Self Employed) and Extractvalue(..."). screenQuery in
-- worker/lib/safety.js now rejects these shapes at the input boundary; this retires
-- the rows that got in before. A retired row answers 410 and leaves every listing.
-- Exact ids, not a LIKE pattern: a pattern such as '%sleep(%' could catch a real page.
-- The UPDATE touches only rows with retired_at NULL, so a second run changes nothing.
-- No row is deleted.
--
-- Undo:
--   UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'sql-probe'

UPDATE research
   SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'sql-probe'
 WHERE retired_at IS NULL
   AND id IN (
     '0w4r6h465e2c672u',
     '5m6s1y1a0p41085v',
     '6o1d285l4v452v0u',
     '25713h6x171h0g4l',
     '0l504m4759060s6f'
   );
