-- Frank D1 Schema - migration 022 (CP-812)
-- Name keys now read a "+" after a word as "plus" (worker/lib/product-link.js), so
-- "iRobot Roomba j7+" and "iRobot Roomba j7" are two products. The one saved
-- verdict with a "+" in its name (read-only check of production, 2026-10-19) was
-- stored under the old key, which is now the plain j7's key: until this runs, a
-- j7 check would reuse the j7+ verdict. Apply it right after the deploy that
-- ships CP-812. Exact id, not a pattern. A second run changes nothing.
-- The KV claim set under "verify-claims:v1:verify:name:irobot j7 roomba" holds the
-- same j7+ claims and expires by itself within 30 days of 2026-10-08.
--
-- Undo:
--   UPDATE research SET canonical_query = 'verify:name:irobot j7 roomba' WHERE id = '6x525e1n0d3q3739'

UPDATE research
   SET canonical_query = 'verify:name:irobot j7 plus roomba'
 WHERE id = '6x525e1n0d3q3739'
   AND kind = 'verification'
   AND canonical_query = 'verify:name:irobot j7 roomba';
