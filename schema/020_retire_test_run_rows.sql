-- Frank D1 Schema - migration 020 (CP-803)
-- Retire two public test runs. publicResearchFilter hides queries that START with
-- "test " or "verify ", but these carry the marker at the end, so they were listed,
-- linked from autocomplete, and outranked real pages there on view count
-- ("best robot vacuum for pet hair diagnostic 20260621" was what the golden-query
-- eval scored for "best robot vacuum for pet hair").
-- Exact slugs, not a pattern: "test" and "diagnostic" are real product words
-- ("fentanyl test strips", "car diagnostic tool"). A second run changes nothing.
--
-- Undo:
--   UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'test-run'

UPDATE research
   SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'test-run'
 WHERE retired_at IS NULL
   AND slug IN (
     'best-robot-vacuum-for-pet-hair-diagnostic-20260621-24173s2r',
     'best-mechanical-keyboards-2026-unique-test-4829-ae066c0c'
   );
