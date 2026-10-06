-- Frank D1 Schema - migration 017
-- Retire the reports that the SEO flywheel made (refocus 2026-10).
-- Spec: docs/refocus-2026-10/spec.md (decisions D1 and D2, section 4.1).
--
-- retired_at       Unix epoch seconds when the row left public view. NULL means live.
-- retired_reason   Why the row left public view. This migration writes 'seo-flywheel'.
--
-- Rule: a research row that runFlywheelTick created. A keyword_queue row links
-- to it through research_id, and research.query equals LOWER(TRIM(keyword)).
-- Verification rows never match. The UPDATE touches only rows with
-- retired_at NULL, so a second run changes nothing. No row is deleted.
--
-- Undo for all rows:
--   UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'seo-flywheel'

ALTER TABLE research ADD COLUMN retired_at INTEGER;
ALTER TABLE research ADD COLUMN retired_reason TEXT;

UPDATE research
   SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'seo-flywheel'
 WHERE retired_at IS NULL
   AND (kind IS NULL OR kind != 'verification')
   AND EXISTS (SELECT 1 FROM keyword_queue k
               WHERE k.research_id = research.id
                 AND LOWER(TRIM(k.keyword)) = research.query);
