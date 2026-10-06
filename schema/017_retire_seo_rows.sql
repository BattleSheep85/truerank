-- Frank D1 Schema - migration 017
-- Retire the reports that the SEO flywheel made (refocus 2026-10).
-- Spec: docs/refocus-2026-10/spec.md (decisions D1 and D2, section 4.1).
--
-- retired_at       Unix epoch seconds when the row left public view. NULL means live.
-- retired_reason   Why the row left public view. This migration writes 'seo-flywheel'.
--
-- Rule: retire a research row only when all of these are true.
--   1. A keyword_queue row links to it through research_id, and research.query
--      equals LOWER(TRIM(keyword)). runFlywheelTick writes this shape.
--   2. kind is not 'verification'.
--   3. clarifications is NULL. runFlywheelTick never writes clarifications.
--      Only a person who answers the clarifying questions does.
--   4. No user_searches row links to it. handleStartResearch writes that link
--      for a signed-in person on a new run and on a cluster hit.
--   5. No subscribers row links to it. A person asked for email about it.
-- The UPDATE touches only rows with retired_at NULL, so a second run changes
-- nothing. No row is deleted.
--
-- What the rule cannot tell apart: runFlywheelTick links a keyword to a row
-- in two ways. The new-run branch inserts the row. The clustered branch points
-- research_id at a complete row that already existed (often a person's row).
-- Both branches end with status 'done', research_id, and done_at set, and
-- research has no column that records who created it (tier is 'full' on both
-- paths). So a row that an anonymous person made, with no clarifications, no
-- subscriber, and a query with the same text as a keyword that later
-- clustered onto it, still matches and gets retired. The undo below brings it
-- back.
--
-- Rule 4 and rule 5 also keep live a row that the flywheel made when a
-- signed-in person later clustered onto it or a person subscribed to it.
-- That is the safe direction.
--
-- Undo for all rows:
--   UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'seo-flywheel'

ALTER TABLE research ADD COLUMN retired_at INTEGER;
ALTER TABLE research ADD COLUMN retired_reason TEXT;

UPDATE research
   SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'seo-flywheel'
 WHERE retired_at IS NULL
   AND (kind IS NULL OR kind != 'verification')
   AND clarifications IS NULL
   AND EXISTS (SELECT 1 FROM keyword_queue k
               WHERE k.research_id = research.id
                 AND LOWER(TRIM(k.keyword)) = research.query)
   AND NOT EXISTS (SELECT 1 FROM user_searches us WHERE us.research_id = research.id)
   AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.research_id = research.id);
