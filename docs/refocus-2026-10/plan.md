# Refocus 2026-10: plan

After this ships, the cron no longer makes or refreshes keyword reports. The 362 keyword-made reports answer 410 Gone and appear on no list, hub, feed, sitemap, or search. The homepage leads with one box where a person pastes a product link or name and gets an honest verdict. The verdict opens at once when Frank checked the same product in the last 30 days.

Design and decisions: `docs/refocus-2026-10/spec.md` (D1 to D8, R1 to R13).

## Ground rules

- Root: `/home/chris/projects/web/frank`. All paths below are absolute.
- Off-limits (uncommitted work by someone else, do not write): `issues.md`, `scripts/run-tests.mjs`, `worker/handlers/research.js`, `worker/pages/research-page.js`, `worker/routes/pages.js`, `wrangler.toml`, `wrangler.dev.toml`, `test/unit/spend-gate.test.js`, `test/unit/view-counter.test.js`, `worker/lib/spend-gate.js`, `worker/lib/view-counter.js`.
- Test discovery: `scripts/run-tests.mjs` is off-limits. A new pure test file would not run. So pure tests go into a suite file that the runner already registers. Any new `test/integration/*.spec.js` runs under `vitest` with no registration.
- Gates: `node scripts/run-tests.mjs` (the only suite CI runs) and `npx vitest run` (local, after `npm install`).
- Each piece writes at most 3 files. It has one gate and one dominant risk. No two pieces write the same file.
- No runtime dependency. No Tailwind rebuild: reuse classes that already exist in the file you edit.
- Prose in code comments and UI copy: ASD-STE100 style, no em or en dashes.

## Rollout checklist

Do the steps in this order. Steps 3 to 5 are owner steps on production.

1. Merge piece 1 and push. This stops new keyword spend at once.
2. Merge piece 2 (migration file only, no runtime change).
3. Run the dry-run count on production. The query is the WHERE clause of migration 017 without `retired_at IS NULL` (that column does not exist yet). The exact number is unknown. Expect about 362 or fewer: the earlier rule counted about 362, and the current rule also keeps live the rows with clarifications, a `user_searches` link, or a `subscribers` link. If the number is above 400 or below 300, stop and investigate. If the query fails with "no such table", stop: migrations 005 and 007 are not in production.
   ```bash
   cd /home/chris/projects/web/frank && export $(grep -v '^#' .cf-token | xargs)
   npx wrangler d1 execute DB --remote --command "SELECT COUNT(*) AS n FROM research r WHERE (r.kind IS NULL OR r.kind != 'verification') AND r.clarifications IS NULL AND EXISTS (SELECT 1 FROM keyword_queue k WHERE k.research_id = r.id AND LOWER(TRIM(k.keyword)) = r.query) AND NOT EXISTS (SELECT 1 FROM user_searches us WHERE us.research_id = r.id) AND NOT EXISTS (SELECT 1 FROM subscribers s WHERE s.research_id = r.id)"
   ```
4. Apply migration 017 to dev and production.
   ```bash
   npx wrangler d1 execute DB --remote --config wrangler.dev.toml --file=schema/017_retire_seo_rows.sql
   npx wrangler d1 execute DB --remote --file=schema/017_retire_seo_rows.sql
   ```
5. Check the result. Expect one `seo-flywheel` group with the same number of rows as the step 3 count.
   ```bash
   npx wrangler d1 execute DB --remote --command "SELECT retired_reason, COUNT(*) AS n FROM research GROUP BY retired_reason"
   ```
6. Merge pieces 3, 4, 5, and 6 (any order) and push.
7. Merge pieces 7 and 8 together, in one push.
8. Run the piece 9 validation. Merge piece 9 only when it meets the acceptance bar. Push.
9. Merge pieces 10 and 11 and push.
10. Merge pieces 12 and 13 and push.
11. Smoke check production:
    ```bash
    SLUG=$(npx wrangler d1 execute DB --remote --json --command "SELECT slug FROM research WHERE retired_reason='seo-flywheel' LIMIT 1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=s.indexOf("[");console.log(JSON.parse(s.slice(i))[0].results[0].slug)})')
    curl -s -o /dev/null -w '%{http_code}\n' "https://chrisputer.tech/research/$SLUG"   # 410
    curl -s -o /dev/null -w '%{http_code}\n' https://chrisputer.tech/best/nas           # 404
    curl -s https://chrisputer.tech/sitemap.xml | grep -c "$SLUG"                      # 0
    curl -s https://chrisputer.tech/ | grep -c 'data-query="best'                      # 0
    ```
12. Optional: resubmit `sitemap.xml` in Google Search Console.

Undo the retirement at any time:

```sql
UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'seo-flywheel';
```

---

## Piece 1. CHANGE: SEO flywheel off by default

Requirement: R1. Decision: D3.

Files:
- `/home/chris/projects/web/frank/worker/lib/keywords.js`
- `/home/chris/projects/web/frank/test/integration/flywheel-off.spec.js` (new)

Change:
1. Add the exported function below. Make it the first statement of `runFlywheelTick`, before the `SERPER_API_KEY` gate and before `sweepOutcomes`.
2. In `runReresearchSweep`, add `AND retired_at IS NULL` to both candidate SELECTs. This SQL runs only when the flag is on. It needs migration 017. A failure there stays inside the existing try/catch.
3. Update the module header comment: off by default since the 2026-10 refocus, see spec D3.
4. Do not change `worker/jobs.js`. It already logs only ticks that are not `skipped`.

Interface:

```js
/** True only when env.SEO_FLYWHEEL_ENABLED is true, 'true', or '1'. */
export function seoFlywheelEnabled(env) { /* ... */ }

// first statement of runFlywheelTick:
if (!seoFlywheelEnabled(env)) return { status: 'skipped', reason: 'disabled' };
```

Edge cases: `env` undefined gives false. `'TRUE'`, `'false'`, `''`, and `'0'` give false.

Test contract (`flywheel-off.spec.js`):
1. Seed one `pending` keyword. Call `runFlywheelTick({ ...env, SERPER_API_KEY: 'test-key' }, Date.now())`. Expect `{ status: 'skipped', reason: 'disabled' }`. The keyword stays `pending`. The `research` row count does not change. KV key `flywheel:<YYYY-MM-DD>` stays absent.
2. `seoFlywheelEnabled` returns true for `'true'`, `true`, `'1'`. It returns false for `undefined`, `'false'`, `''`, `'0'`, `'TRUE'`, and `{}` (no key).
3. `worker.scheduled({ scheduledTime: Date.now() }, env, ctx)` does not throw. The reaper still marks a `processing` row older than 20 minutes as `failed`.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/flywheel-off.spec.js test/integration/scheduled-fallback.spec.js
```

Dominant risk: the guard lands in the wrong place and blocks other cron work (reaper, purges, GSC ingest). Fallback: the guard is one statement inside `runFlywheelTick`, and `jobs.js` isolates the tick in its own try/catch. Revert the commit to restore.

Depends on: nothing. Ship first.

---

## Piece 2. ADD: migration 017, retire columns and backfill

Requirements: R2, R13. Decisions: D1, D2.

Files:
- `/home/chris/projects/web/frank/schema/017_retire_seo_rows.sql` (new)
- `/home/chris/projects/web/frank/test/integration/_schema.js`
- `/home/chris/projects/web/frank/test/integration/retire-migration.spec.js` (new)

Change:
1. Write `017_retire_seo_rows.sql` with the header style of migration 016. The body is the SQL in spec section 4.1. The header comments name the two columns, the rule, the spec path, and the undo statement.
2. Keep `;` out of comments and string literals, and keep `--` out of string literals. `_schema.js` strips `--` comments and splits on `;`. Write the undo statement in the header comment without a trailing `;`.
3. In `_schema.js`, import the file with `?raw` and append it last in the `applySchema` list.

Interface (schema):
- `research.retired_at INTEGER NULL`: unix epoch seconds when the row left public view. NULL means live.
- `research.retired_reason TEXT NULL`: `'seo-flywheel'` for this migration.

Test contract (`retire-migration.spec.js`). After `applySchema`, seed the rows below. Then run only the UPDATE statements of the migration file (strip `--` comments, split on `;`, keep statements that start with `UPDATE`).

| Row | Seed | Expect |
|---|---|---|
| A | keyword `' Best NAS for Plex '` linked to research query `'best nas for plex'`, kind NULL | `retired_reason = 'seo-flywheel'`, `retired_at` is an integer |
| B | keyword `'best widget under $50'` linked to research query `'cheap widgets for my desk'` | not retired (clustered) |
| C | research query `'best gizmo 2026'`, no keyword link | not retired |
| D | keyword `'sony wh-1000xm6'` linked to a `kind = 'verification'` row with the same query | not retired |
| E | keyword `'best tent'` with `research_id` NULL, status `failed` | no effect |

Also:
- A second run of the UPDATE does not change `retired_at` on row A.
- A row that `insertResearch` creates has `retired_at` NULL.

Gate (the `_schema.js` change touches every spec, so run all of them):

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run
```

Dominant risk: the backfill marks the wrong rows in production. Fallback: nothing deletes a row. The dry-run count (rollout step 3) comes before the apply, and one UPDATE undoes the change.

Depends on: nothing. Before pieces 4, 5, 11, and 12 merge, the owner applies it to dev and production (rollout steps 3 to 5).

---

## Piece 3. CHANGE: 410 Gone for retired report URLs

Requirement: R3. Decision: D2.

Files:
- `/home/chris/projects/web/frank/worker/lib/retired.js` (new)
- `/home/chris/projects/web/frank/worker/index.js`
- `/home/chris/projects/web/frank/test/integration/retired-routes.spec.js` (new)

Interface (`retired.js`):

```js
export const RETIRED_REASON_SEO_FLYWHEEL = 'seo-flywheel';

/**
 * True when the research row with this slug has retired_at set.
 * Missing row: false. Any error: console.error with context, then false (fail-open).
 */
export async function isRetiredResearchSlug(db, slug) { /* SELECT retired_at FROM research WHERE slug = ?1 */ }

/**
 * 410 Gone. HTML body when Accept includes text/html, else text/plain "Gone".
 * Follows the notFound() pattern in worker/lib/http-response.js: standalone HTML,
 * no AdSense loader (no ads on error pages), wrapped in withSecurityHeaders(res, null).
 * Headers: Content-Type, Cache-Control 'public, max-age=3600', X-Robots-Tag 'noindex'.
 */
export function retiredReportResponse(request) { /* ... */ }
```

Page copy (HTML body):
- Title: "This report is gone | Frank". Include `<meta name="robots" content="noindex">`.
- Heading: "This report is gone."
- Text: "Frank no longer publishes "best of" lists made from search keywords. To check a product, paste its link or name on the home page."
- Links: "Check a product" to `/`, and "Read the buying guides" to `/best/`.

Change (`index.js`, the `slugMatch` branch for `/^\/research\/([a-z0-9-]+)$/`). Put the check before `handleResearchPage`, which also puts it before the KV page cache:

```js
if (await isRetiredResearchSlug(env.DB, slugMatch[1])) return retiredReportResponse(request);
return handleResearchPage(slugMatch[1], url, request, env, ctx);
```

Edge cases:
- HEAD answers 410 too (the branch sits inside `isGetLike`).
- A legacy `/report/:id` link 301s to `/research/<slug>` and then gets 410. That is correct.
- `/research/<slug>/og.svg` does not change.
- `/research/new` matches earlier in the router, so the guard never sees it.

Test contract (`retired-routes.spec.js`):
1. Seed a complete row with 3 products and `retired_at` set. GET with `Accept: text/html` gives 410. The body contains `href="/"`, `href="/best/"`, and `noindex`. The body does not contain `googlesyndication`. The `X-Content-Type-Options` header is present.
2. HEAD of the same URL gives 410.
3. GET without an Accept header gives 410 with a text/plain body.
4. A live row (`retired_at` NULL) gives 200.
5. An unknown slug keeps the current behavior (404).
6. Put a KV page-cache entry `page:${CACHE_VERSION}:<retired slug>` in place. The URL still gives 410.
7. `isRetiredResearchSlug` with a stub `db` whose `prepare` throws returns false.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/retired-routes.spec.js test/integration/index.spec.js test/integration/consent-routes.spec.js test/integration/report.spec.js
```

Dominant risk: a false positive answers 410 for a live report, or the extra D1 read slows report pages. Fallback: the check is fail-open and is one `if` in `index.js`. Remove it to restore. If p95 latency rises by more than 20 ms, move the check into the KV-cache path (backlog B10).

Depends on: 2 (the spec needs the column through `_schema.js`). Safe in production before 017 is live, because it fails open. It logs an error per report view until 017 is live, so apply 017 first.

---

## Piece 4. CHANGE: hide retired rows from listings, the cluster cache, and verify alternatives

Requirement: R4. Decision: D2.

Files:
- `/home/chris/projects/web/frank/worker/lib/utils.js`
- `/home/chris/projects/web/frank/worker/lib/db.js`
- `/home/chris/projects/web/frank/test/integration/retired-hidden.spec.js` (new)

Change:
1. `publicResearchFilter(alias)`: append `AND ${alias}.retired_at IS NULL`. Add one comment line that points to spec D2. Every caller of `publicResearchFilter` gets it: the `listable.js` queries (homepage and `/best/` recent lists, browse and count, autocomplete, sitemap, feed), the shared lastmod, `getClusterWinnerSlug`, and `listCategories`.
2. `db.js` `findResearchByCanonicalQuery`: add `AND retired_at IS NULL`. Without it, a new query that clusters onto a retired row sends the person to a 410 page.
3. `db.js` `findRankingForCategory`: add `AND retired_at IS NULL`. Verify pages must not show alternatives from, or link to, a retired report.

Test contract (`retired-hidden.spec.js`). Seed two public rows (3 products each) with the same `canonical_query` and category `Widgets`. Mark the newer one retired. Seed one more unrelated retired public row.
1. `listableRowsSql()` rows exclude both retired rows. The older live cluster member wins its cluster.
2. `listableCountSql()` counts live clusters only.
3. `getClusterWinnerSlug(db, canonical)` returns the live member.
4. GET `/sitemap.xml`, GET `/feed.xml`, GET `/api/search/suggest?q=widget`, and GET `/research` contain no retired slug.
5. `recentReportsSection(env)` from `worker/pages/home.js` contains no retired slug.
6. `findResearchByCanonicalQuery(db, canonical)` returns the live row. It returns null when only a retired row matches.
7. `findRankingForCategory(db, 'widgets')` skips the retired row.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run
```

Dominant risk: a deploy before 017 is live in production breaks every listing with "no such column: retired_at". Fallback: apply 017 (one command, rollout step 4) or revert this commit. Precondition: rollout step 5 shows the `seo-flywheel` group.

Depends on: 2, and 017 live in dev and production.

---

## Piece 5. CHANGE: hide retired products from /reviews

Requirement: R4.

Files:
- `/home/chris/projects/web/frank/worker/lib/product-search.js`
- `/home/chris/projects/web/frank/test/unit/product-search.test.js`

Change: `buildProductWhere` base conditions get `'r.retired_at IS NULL'`. The facet queries call the same builder, so they inherit it. Binds do not change.

Test contract (add to `runProductSearchTests`):
1. The base clause includes `r.retired_at IS NULL`.
2. The clause for each `exclude` value (`'category'`, `'brand'`, `'price'`, `'rating'`) includes it.
3. Bind arrays stay identical to today for the existing cases.

Gate (the integration specs render `/reviews` against D1 with the column):

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/index.spec.js test/integration/consent-routes.spec.js
```

Dominant risk: the same deploy-order risk as piece 4 (`/reviews` fails without the column). Fallback: apply 017 or revert.

Depends on: 2, and 017 live.

---

## Piece 6. CHANGE: retire the dynamic /best/ hubs

Requirement: R5. Decision: D4.

Files:
- `/home/chris/projects/web/frank/worker/pages/category.js`
- `/home/chris/projects/web/frank/test/integration/consent-routes.spec.js`
- `/home/chris/projects/web/frank/test/integration/hubs-retired.spec.js` (new)

Change:
1. `renderCategoryHub(category, env)` returns `null` at once. `routes/pages.js` `handleBestHub` then answers `notFound()`.
2. `listCategories(env)` returns `[]` at once. The sitemap hub list and the browse category strip go empty with no change to `sitemap.js` or `browse.js`.
3. Keep both exports and `MIN_HUB_GUIDES`, because `routes/pages.js`, `sitemap.js`, and `browse.js` import them. Delete the dead function bodies and the imports that only they used. Rewrite the header comment: hubs retired 2026-10 (spec D4), cleanup in backlog B10.
4. In `consent-routes.spec.js`, delete the `{ name: 'category hub page', path: '/best/nas' }` entry. It expects 200.

Test contract (`hubs-retired.spec.js`):
1. Seed 2 public rows in category `NAS`. GET `/best/nas` gives 404.
2. GET `/best/mechanical-keyboards-under-100/` gives 200 (the static guide still wins).
3. `/sitemap.xml` contains the 4 static guide URLs and no other `/best/<slug>` URL.
4. GET `/research` does not contain "Browse by category".
5. The existing `index.spec.js` test (`/best/nas` gives 200 or 404) still passes.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run
```

Dominant risk: a static guide stops answering. Fallback: `handleBestHub` probes ASSETS first and does not change. Test 2 guards the guide. Revert restores the hubs.

Depends on: nothing (no column).

---

## Piece 7. FIX: honest overall score

Requirement: R6. Decision: D7.

Files:
- `/home/chris/projects/web/frank/worker/lib/verdict.js`
- `/home/chris/projects/web/frank/test/unit/verdict.test.js`

Interface:

```js
export const MIN_CHECKED_CLAIMS = 2;
export const MIN_CHECKED_SHARE = 0.25;
export const INSUFFICIENT_EVIDENCE_LABEL = 'Not enough independent evidence';

/**
 * @param {Array<{status: string, claimType?: string}>} claimVerdicts
 * @returns {{ score: number|null, label: string, checkedCount: number, claimCount: number }}
 */
export function overallVerdict(claimVerdicts) { /* ... */ }
```

Rules (spec section 4.5):
1. Decided claims have status `verified` (1.0), `partially-verified` (0.5), or `contradicted` (0.0).
2. The score is the weighted mean over decided claims only. The claim-type weights do not change.
3. `score: null` and `INSUFFICIENT_EVIDENCE_LABEL` when `claimCount === 0`, `checkedCount < MIN_CHECKED_CLAIMS`, or `checkedCount / claimCount < MIN_CHECKED_SHARE`.
4. Otherwise the existing `SCORE_BANDS` give the label.
5. Remove `unsubstantiated` from `STATUS_VALUE`, because it no longer feeds the score. Update the JSDoc.
6. A non-array input acts like `[]`.

Callers (no edits in this piece):
- `worker/engine/verify.js` stores the object in `result.overall`.
- `verify-orchestrator.js` writes `overall_score` NULL (the column allows NULL). Its `buildSummary` already handles a score that is not finite.
- `handlers/verify.js` returns `overallScore: null`.
- Piece 8 renders the null state.

Test contract (update the existing `overallVerdict` blocks, then add these):
1. `[]` and `undefined` give `{ score: null, label: INSUFFICIENT_EVIDENCE_LABEL, checkedCount: 0, claimCount: 0 }`.
2. 4 unsubstantiated claims give `score: null`.
3. 1 verified and 3 unsubstantiated give `score: null` (1 decided, below 2).
4. 2 verified and 7 unsubstantiated give `score: null` (2/9 is below 0.25).
5. 2 verified and 6 unsubstantiated give 100, "Lives up to its claims", `checkedCount: 2`, `claimCount: 8` (2/8 meets the floor).
6. `[verified, contradicted]` and `[verified, contradicted, unsubstantiated, unsubstantiated]` give the same score.
7. The existing weighting test still holds: a contradicted spec claim pulls harder than a contradicted marketing claim.
8. Rewrite each band test so that its claims are all decided.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs
```

Dominant risk: new runs store `score: null`, and the current page prints "0/100" until piece 8 ships. Fallback: ship pieces 7 and 8 in one push (rollout step 7).

Depends on: nothing. Deploy together with piece 8.

---

## Piece 8. CHANGE: verify pages show the honest verdict

Requirements: R7, part of R9. Decisions: D7, D8.

Files:
- `/home/chris/projects/web/frank/worker/pages/verify-page.js`
- `/home/chris/projects/web/frank/test/unit/verification-render.test.js`

Interface:

```js
/**
 * The verdict to show for a stored verification result. Computes it again from
 * result.claims with overallVerdict. Never reads result.overall or row.overall_score.
 * Never throws: a missing, non-object, or non-array input gives
 * { score: null, label: INSUFFICIENT_EVIDENCE_LABEL, checkedCount: 0, claimCount: 0 }.
 */
export function honestOverall(result) { /* ... */ }
```

Change:
1. `renderCompleteReport` uses `honestOverall(result)` everywhere it used `result.overall` or `row.overall_score`. Old reports get the honest verdict with no data migration.
2. Gauge, pill, and instrument panel: a number shows `<n>/100`. For `null`, show the readout "No score" and the insufficient label, with the neutral band classes. Never print `0/100` for `null`.
3. Under the verdict, show "Frank found independent tests for {checkedCount} of {claimCount} claims."
4. Show "Checked on <Mon D, YYYY>" from `row.completed_at` in UTC. This is the YTBS "first analyzed on" date. A person who gets a saved verdict sees when Frank checked.
5. `isLowScore` is true only when `typeof score === 'number' && score < 50`. Apply this in `renderCompleteReport` and in `renderAlternatives`. Today `Number(null)` is 0, so a null score would count as low.
6. `renderAlternatives(row, resultJson, env, findRanking)` keeps its signature. It reads the score through `honestOverall(resultJson)`.
7. Page title: a number gives `${product}: ${n}/100, ${label}`. `null` gives `${product}: claim check`. `layout()` adds " | Frank". Build the description from the honest verdict and the counts, not from `row.summary`, because old summaries carry the old score.
8. Entry page (`renderVerifyEntryPage`):
   - Keep up to 2,048 characters of the prefill (today: 200).
   - Set the input `maxlength="2048"` and the placeholder "Paste a product link or type its name".
   - Set the label to "Product link or name".
   - Make the intro sentence say that a link works.

Test contract:
1. The existing 4-claim fixture (verified spec, partial, unsubstantiated, contradicted) renders the number that `overallVerdict(fixture.claims)` returns, and "3 of 4 claims". Assert the computed number, not 62.
2. An all-unsubstantiated fixture renders "No score" and the insufficient label. `0/100` appears nowhere. The alternatives block does not take the low-score position.
3. A fixture with `claims: []` renders the insufficient label and does not throw.
4. A stored `result.overall` of `{ score: 85 }` with only unsubstantiated claims: the page ignores 85.
5. `completed_at = 1700000100` renders "Checked on Nov 14, 2023".
6. `<title>` contains `/100` only when the score is a number.
7. The entry page HTML contains `maxlength="2048"`, and a 600-character prefill survives.
8. All existing escaping, link-gate, and methodology assertions still pass.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/consent-routes.spec.js test/integration/verify.spec.js
```

Dominant risk: a render path throws on an old row with odd JSON. Fallback: `honestOverall` never throws, and the render smoke test covers throws. Revert restores the old page.

Depends on: 7 (same push).

---

## Piece 9. FIX: claim-aware evidence for the stance check

Requirement: R8. Decision: D7 (the cure).

Files:
- `/home/chris/projects/web/frank/worker/engine/verify.js`
- `/home/chris/projects/web/frank/test/unit/verify.test.js`
- `/home/chris/projects/web/frank/benchmarks/verify-product.mjs` (its `stanceForClaim` must pass the claim, or the validation does not test the change)

Interface:

```js
/** Lowercase claim tokens without stopwords. Keeps numbers and unit tokens ('40', 'hours', 'ipx4', '98'). Unique, at most 12. */
export function claimTerms(claimText) { /* ... */ }

/**
 * claim == null: today's order (verificationWeight desc). Regression guard.
 * claim given: sources with at least one term hit first, by (hits / terms) * verificationWeight desc,
 * then verificationWeight desc. Returns at most n items. Does not change the input array.
 */
export function topEvidenceForClaim(evidence, n = 15, claim = null) { /* ... */ }

/** The maxChars window of content with the most term hits. No hits: content.slice(0, maxChars). */
export function claimPassage(content, terms, maxChars = 1200) { /* ... */ }
```

Change:
1. `runVerification` passes the claim: `topEvidenceForClaim(scoredEvidence, 15, claim)`.
2. `classifyStance` builds each evidence block from `claimPassage(s.content, claimTerms(claim.text), 1200)` instead of `(s.content || '').slice(0, 1200)`.
3. `benchmarks/verify-product.mjs` `stanceForClaim` calls `topEvidenceForClaim(evidence, 15, claim)`.

Test contract (add to `runVerifyTests`):
1. Claim "Battery lasts up to 40 hours": a source that mentions "battery" and "hours" ranks first. A higher-weight source that mentions neither ranks below it.
2. With `claim` null, the order equals the current order for the same fixture.
3. Put "41.5 hours" at character 7,000 of a 10,000-character text. `claimPassage` returns the window that contains it.
4. No hits returns the first 1,200 characters.
5. `claimTerms` drops stopwords and keeps "40" and "ipx4".

Validation before merge (paid, about $2, inside `MONTHLY_BUDGET_USD`). Use the existing harness `benchmarks/verify-product.mjs`. It reads keys from `.dev.vars` and has a `REPLAY` mode that keeps claims and evidence fixed, so the A/B isolates this change.
1. On the base commit (before this piece), run the harness once per product. This pins claims and evidence in `benchmarks/results/verify-<slug>.json`. Products: "Sony WH-1000XM6 headphones", "JBL Flip 7 speaker", "Creality K2 Combo", "Anker Soundcore Liberty 4 NC", "Alienware 34 QD-OLED AW3423DWF".
   ```bash
   cd /home/chris/projects/web/frank && node benchmarks/verify-product.mjs "Sony WH-1000XM6 headphones"
   ```
2. On this piece, run `REPLAY=benchmarks/results/verify-<slug>.json node benchmarks/verify-product.mjs` for each product.
3. Baseline from production: 64 of 74 claims unsubstantiated (86%). Compare the base runs with the replays.
4. Accept when the unsubstantiated share in the replays is 60% or less.
5. Pick 10 random support or contradict spans from the replays for a human spot check. Accept only when at least 8 are a real test or measurement of that claim by the source itself.
6. Attach the counts and the 10 spans to the pull request. Keep the new result JSON files out of the commit.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs
```

Dominant risk: more false "verified" or "contradicted" verdicts. Fallback: the change is two call sites. Revert restores claim-agnostic selection. The spot check is the merge guard.

Depends on: nothing in code. Merge after pieces 7 and 8, so the page shows the new numbers honestly.

---

## Piece 10. ADD: product link parsing (pure)

Requirement: R9. Decision: D8.

Files:
- `/home/chris/projects/web/frank/worker/lib/product-link.js` (new)
- `/home/chris/projects/web/frank/test/unit/lib-pure.test.js`

Interface:

```js
export const PRODUCT_INPUT_MAX_LEN = 2048;
export const PRODUCT_NAME_MAX_LEN = 200;
export const VERIFY_KEY_PREFIX = 'verify:';

/**
 * Parse what a person typed or pasted into the Verify box. Pure. Never throws.
 * @param {string} raw product name, product page link, or share text that contains a link
 * @returns {Readonly<{ kind: 'url'|'name', name: string|null, url: string|null, key: string|null }>}
 *   key is the full stored key, prefix included (for example 'verify:asin:B0F3PT1VBL').
 */
export function parseProductInput(raw) { /* ... */ }

/** 'verify:name:' + sorted unique lowercase [a-z0-9]+ tokens joined by ' ' (at most 20). null when no token. */
export function productNameKey(name) { /* ... */ }
```

Rules, in order:
1. Find the first `https?://` token in `raw`. None: `kind 'name'`, `name` = trimmed raw capped at 200 (null when empty), `url` null, `key` = `productNameKey(name)`.
2. Link found: strip trailing `.,;:!?)]}>"'` characters. Parse it with `new URL`. Change `http:` to `https:`. A parse failure or `!isFetchableUrl(url)` (from `worker/lib/url-guard.js`) gives `{ kind: 'url', name: null, url: null, key: null }`.
3. Amazon host (matches `/(^|\.)amazon\.[a-z.]+$/`, so `amazon.com`, `www.amazon.co.uk`, and `smile.amazon.com` all count):
   - ASIN: 10 characters `[A-Z0-9]` after `/dp/`, `/gp/product/`, or `/gp/aw/d/`, in uppercase.
   - `url` = `https://<host>/dp/<ASIN>`. `key` = `verify:asin:<ASIN>`.
   - `name`: the path segment right before `/dp/`, when it has 2 or more hyphen-separated words and contains a letter. Hyphens become spaces. Keep the first 10 words.
4. Short hosts (`a.co`, `amzn.to`, `amzn.eu`, `amzn.asia`): `url` = the https link as given. `name` comes from rule 6, else null. `key` = `productNameKey(name)` when there is a name, else null.
5. Other hosts:
   - `url` = `https://<host><pathname>` with no query, no hash, and no trailing slash.
   - `key` = `verify:url:<host without www.><pathname in lowercase>`.
   - `name`: the longest path segment with 2 or more words split by hyphens or underscores. It must contain a letter and must not be an ID. Separators become spaces. Keep the first 10 words.
   - Known shapes: Best Buy `/site/<slug>/<sku>.p`, Walmart `/ip/<slug>/<id>`, Target `/p/<slug>/-/A-<id>`.
6. Remainder: `raw` without the link, trimmed. Use it as `name` (capped at 200) only when rules 3 to 5 found no name. The remainder must hold 3 or more letters or digits.
7. Freeze the output object.

Test contract (add a `product-link.js` block to `runLibPureTests`):

| Input | Expect |
|---|---|
| `'Sony WH-1000XM6'` | `kind 'name'`, `key 'verify:name:1000xm6 sony wh'`, `url` null |
| `'WH-1000XM6 sony'` | the same key |
| `'MacBook Air 2024'` and `'MacBook Air 2022'` | different keys |
| `'https://www.amazon.com/Sony-WH-1000XM6-Cancelling-Headphones/dp/B0F3PT1VBL/ref=sr_1_1?crid=X&th=1'` | `name 'Sony WH 1000XM6 Cancelling Headphones'`, `url 'https://www.amazon.com/dp/B0F3PT1VBL'`, `key 'verify:asin:B0F3PT1VBL'` |
| `'https://www.amazon.com/dp/b0f3pt1vbl'` | `key 'verify:asin:B0F3PT1VBL'`, `name` null |
| `'https://www.amazon.co.uk/gp/product/B0F3PT1VBL'` | `key 'verify:asin:B0F3PT1VBL'` |
| `'http://www.bestbuy.com/site/sony-wh1000xm6-wireless-headphones/6612345.p?skuId=6612345'` | https `url` without the query, `name 'sony wh1000xm6 wireless headphones'`, `key 'verify:url:bestbuy.com/site/sony-wh1000xm6-wireless-headphones/6612345.p'` |
| `'Sony WH-1000XM6 https://a.co/d/abc123'` | `url 'https://a.co/d/abc123'`, `name 'Sony WH-1000XM6'`, key from the name |
| `'https://a.co/d/abc123'` | `name` null, `key` null |
| `'https://192.168.1.10/product'` | `url` null, `key` null |
| `'see https://example.com/p/widget-pro-max)'` | the trailing `)` is gone from `url` |
| `'javascript:alert(1)'` | `kind 'name'` |
| `''` | `name` null, `key` null |

Also assert `Object.isFrozen` on a result.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs
```

Dominant risk: a wrong key merges two different products, so a person sees the wrong saved verdict. Fallback: keys keep every token and number, so they prefer misses. The module has no caller until piece 11.

Depends on: nothing.

---

## Piece 11. CHANGE: verify intake takes a link and reuses saved verdicts

Requirements: R9, R10. Decision: D8.

Files:
- `/home/chris/projects/web/frank/worker/handlers/verify.js`
- `/home/chris/projects/web/frank/test/integration/verify-route.spec.js`

Interface:

```js
export const VERIFY_REUSE_MAX_AGE_DAYS = 30; // 0 turns reuse off

/** Newest complete verification with this key that completed at or after nowSec - window. */
export async function findSavedVerdict(db, key, nowSec) { /* returns { id, slug, completed_at } | null */ }
```

```sql
SELECT id, slug, completed_at FROM research
 WHERE canonical_query = ?1 AND kind = 'verification' AND status = 'complete'
   AND completed_at >= ?2 AND retired_at IS NULL
 ORDER BY completed_at DESC, id DESC LIMIT 1
```

The existing index `idx_research_canonical (canonical_query, status, created_at)` covers the lookup.

Flow of `handleStartVerify`:
1. `raw = String(body.product ?? '').trim()`. Fewer than 3 characters: 400 (as today). More than `PRODUCT_INPUT_MAX_LEN`: 400.
2. Resubmit (`reportId` present): unchanged, except that the queue message uses the stored `row.query` as `product`.
3. New submission:
   1. `parsed = parseProductInput(raw)`.
   2. `kind 'url'` with `url` null: 400 "Frank cannot check that link. Paste the address of a public product page."
   3. `kind 'url'` with `name` null: 422 `{ error: 'That link does not include the product name. Copy the full address from the product page, or type the product name.', code: 'name_required' }`.
   4. Validate the name with the current rules: 3 to `PRODUCT_NAME_MAX_LEN` characters, at least 3 letters or digits. Run `screenQuery(name)` as now.
   5. `productUrl` = a valid `body.productUrl` (the current check), else `parsed.url`.
4. Burst gate and hourly limit: unchanged.
5. New submission with `parsed.key`: call `findSavedVerdict`. A hit returns 200 `{ id, slug, status: 'completed', reused: true, checkedAt: completed_at }`. A hit reads and writes no quota, skips the budget gate, sends no queue message, and inserts no row.
6. Otherwise: budget gate, then quota, as today. Then `INSERT` with `query = name`, `subject_url = productUrl`, and `canonical_query = parsed.key` (NULL when there is no key). Then enqueue `{ reportId, kind: 'verification', product: name, productUrl }`. The response stays `{ id, slug, status: 'pending' }`.

Clients: the `/verify` page script and the new homepage script both navigate on `slug`. A `completed` status opens the saved verdict at once, with no client change on `/verify`.

Test contract (add to `verify-route.spec.js`. All existing cases stay green):
1. An Amazon link with a name gives 200 `pending`. The row has `query` = the derived name, `subject_url = 'https://www.amazon.com/dp/<ASIN>'`, and `canonical_query = 'verify:asin:<ASIN>'`.
2. Intake accepts a 600-character Amazon link (long query string).
3. `'https://a.co/d/abc123'` alone gives 422 with `code 'name_required'`. No row appears.
4. `'https://10.0.0.5/item'` gives 400. No row appears.
5. Seed a complete verification row with `canonical_query 'verify:asin:B0F3PT1VBL'`, completed 1 day ago. The same link from a fresh IP gives 200 `{ status: 'completed', reused: true }` with the seeded slug. The row count does not change. The quota KV value for that IP does not change.
6. Repeat case 5 with the monthly budget used up. The saved verdict still comes back (200). A new product gives 503.
7. The same seeded row completed 31 days ago: a new `pending` row appears.
8. A seeded `needs_input` or `failed` row with the key: a new `pending` row appears.
9. `'WH-1000XM6 Sony'` reuses a complete row keyed `'verify:name:1000xm6 sony wh'`.
10. The too-short, invalid `productUrl`, safety screen, resubmit, burst gate, and status poll cases keep their current results.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/verify-route.spec.js test/integration/quota.spec.js test/integration/verify.spec.js test/integration/burst-gate.spec.js
```

Dominant risk: a reuse hit shows the verdict for a different product. Fallback: piece 10 keeps keys strict. Set `VERIFY_REUSE_MAX_AGE_DAYS` to 0 to turn reuse off with no other change.

Depends on: 10, plus 2 with 017 live (the lookup reads `retired_at`).

---

## Piece 12. ADD: recent verdicts section

Requirement: R12. Decision: D5.

Files:
- `/home/chris/projects/web/frank/worker/pages/home.js`
- `/home/chris/projects/web/frank/test/integration/home-verdicts.spec.js` (new)

Interface:

```js
export const VERDICTS_MARKER = '<!--RECENT_VERDICTS-->';
export const MIN_VERDICTS_TO_SHOW = 3;

/** '' on any error, or when fewer than MIN_VERDICTS_TO_SHOW rows qualify. */
export async function recentVerdictsSection(env, limit = 6) { /* ... */ }
```

Change:
1. Query 24 candidates:
   ```sql
   SELECT slug, query, result, completed_at FROM research
    WHERE kind = 'verification' AND status = 'complete' AND retired_at IS NULL
    ORDER BY completed_at DESC, id DESC LIMIT ?1
   ```
2. A row qualifies when `parseJsonSafe(result).claims` is an array with 3 or more items and `overallVerdict(claims).score` is a number. Keep the first `limit` rows that qualify.
3. Card: product name (`displayQuery(query)`, escaped), `<n>/100`, the label, "<checked> of <claims> claims checked", and "Checked <timeAgo>". The card links to `/verify/<slug>`. Section heading: "Recent verdicts". Reuse the `.card` markup of `recentReportsSection`, with no new Tailwind classes.
4. `injectRecentReports`: when the HTML contains `VERDICTS_MARKER`, replace it with `await recentVerdictsSection(env).catch(() => '')`. Keep the `<!--RECENT_REPORTS-->` handling, because the `/best/` index still uses it.

Test contract:
1. Seed 3 rows that qualify, 1 with 2 claims, 1 with only unsubstantiated claims, and 1 `pending` row. The section lists exactly the 3 qualifying slugs, newest first.
2. Only 2 rows qualify: the result is `''`.
3. Malformed `result` JSON: the section skips the row and does not throw.
4. A product name `'<b>x</b> widget'` comes out escaped.
5. `env.DB.prepare` throws: the result is `''`.

Gate:

```bash
cd /home/chris/projects/web/frank && node scripts/run-tests.mjs && npx vitest run test/integration/home-verdicts.spec.js test/integration/consent-routes.spec.js
```

Dominant risk: one bad row breaks the homepage. Fallback: the section degrades to `''` on any error, the same contract as `recentReportsSection`. Nothing renders until piece 13 places the marker.

Depends on: 7 (score rules), plus 2 with 017 live.

---

## Piece 13. CHANGE: verify-first homepage

Requirements: R11, R12. Decision: D5.

Files:
- `/home/chris/projects/web/frank/public/index.html`
- `/home/chris/projects/web/frank/public/js/app.js`
- `/home/chris/projects/web/frank/test/integration/home-page.spec.js` (new)

Change (`index.html`):
1. Head: `<title>`, meta description, `og:*`, and `twitter:*` become verify-first.
   - Title: "Frank: paste a product link, see which claims hold up".
   - Description: "Paste a product link or name. Frank checks each claim against independent tests and reviews. He shows what holds up, what does not, and what nobody could confirm."
2. Hero form: add `action="/verify" method="get"`, so the form still reaches the prefill page without JavaScript. Input: `name="product"`, `maxlength="2048"`, placeholder "Paste a product link or type its name". Screen-reader label: "Product link or name". Add `<p id="verify-hero-status" role="status" aria-live="polite">` under the form.
3. Hero text under the h1: "Paste a product link or type a product name. Frank checks each claim against independent tests and tells you what holds up. Products Frank already checked open at once."
4. Second card (category research):
   - Eyebrow "Not sure which product?". Heading "Describe what you need". Placeholder "e.g. wide hiking boots for a heavy hiker".
   - Chips (fill the box only): "tires for a 2010 Mazda 3" (`data-query="tires for a 2010 mazda 3"`), "wide hiking boots" (`"wide 4E hiking boots for a heavy hiker"`), "Home Assistant bulbs" (`"smart bulbs that work with Home Assistant"`), "3D printer under $600" (`"3d printer under $600"`).
   - No `data-query` value starts with "best".
   - "Browse every ranking" becomes "Browse past research".
5. Replace `<!--RECENT_REPORTS-->` with `<!--RECENT_VERDICTS-->`.
6. Trust strip: "Every claim checked against independent tests. No paid placements."
7. Final call to action: heading "Paste a product link. See what holds up." The form becomes a second verify form with `id="verify-cta-form"`. It has the same `action`, `method`, and input contract as the hero. It has its own status line.
8. Use only Tailwind classes that already exist in `public/index.html`.

Change (`app.js`):
1. One submit handler for `#verify-hero-form` and `#verify-cta-form`:
   1. `preventDefault`. Do nothing for fewer than 3 characters.
   2. Disable the button and set its text to "Checking…".
   3. `POST /api/verify` with `{ product }`.
   4. A response with `slug` sets `location.href = '/verify/' + slug` (for `pending` and `completed` alike).
   5. A response with `error` writes `data.error` into the status line of that form. When `code === 'signup_required'`, add a link to `/account`. Enable the button again.
   6. A network failure writes "Could not reach Frank. Please try again."
2. Example chips fill `#query-input` and focus it. They do not call `beginResearch`.
3. Keep the `?q=` prefill and the research `search-form` handlers. Remove code that only served the old final call-to-action research form (`#query-input-cta`), if any.

Test contract (`home-page.spec.js`, GET `/`):
1. 200. The HTML has `id="verify-hero-form"` with `action="/verify"` and `maxlength="2048"`.
2. No `data-query="best` anywhere.
3. No literal `<!--RECENT_VERDICTS-->` or `<!--RECENT_REPORTS-->` remains in the output.
4. With 3 qualifying verdicts seeded, the page contains "Recent verdicts" and the 3 `/verify/` links.
5. The existing `consent-routes.spec.js` homepage cases pass (nonce on every inline script, AdSense rules).

Manual check (record it in the pull request):
1. Paste an Amazon link that has a name: the page opens `/verify/<slug>` in the processing state.
2. Paste a link with a saved verdict: the verdict opens at once.
3. Paste a bare a.co link: the status line shows the `name_required` message.
4. With JavaScript off, submit the hero: the browser opens `/verify?product=…` with the box filled.

Gate:

```bash
cd /home/chris/projects/web/frank && node --check public/js/app.js && node scripts/run-tests.mjs && npx vitest run test/integration/home-page.spec.js test/integration/consent-routes.spec.js test/integration/index.spec.js
```

Dominant risk: the hero stops submitting because of a script error. Fallback: the form `action` and `method` still reach `/verify` without JavaScript. Revert `app.js` to restore the old handler.

Depends on: 8, 11 (links work), and 12 (the marker has a renderer).

---

## Backlog (ranked)

1. **B1. Share button and score-aware link previews on verdict pages.** Use `navigator.share`, with a copy fallback. Put the score in `og:title`. For `og:image`, use the product image when one exists, else `og.png`. Files: `worker/pages/verify-page.js` and its render test. Why first: the YTBS growth loop. It is safe once pieces 7 to 9 make the score honest.
2. **B2. Names for links without a name** (a.co, amzn.to, `/dp/<ASIN>` alone). Before the gather step, `worker/pipeline/verify-orchestrator.js` reads the page title, sets the product name, and updates `research.query`. Then `handlers/verify.js` drops the 422. Why: mobile share links carry no name.
3. **B3. PWA share target and "Check again".** Add `share_target` in `public/manifest.webmanifest` that points to `/verify`. The `/verify` route takes the first link from the `text` or `url` parameter and fills the box. A GET never starts a paid run. Saved verdicts get a "Check again" button that skips reuse, with the rate limit and quota.
4. **B4. Verdict sitemap and llms.txt.** List verdict pages that have a number in `sitemap.xml` (`worker/lib/sitemap.js`). Add `public/llms.txt`, which describes Verify and the `/verify/<slug>` pattern.
5. **B5. Agree and disagree votes with a Wilson re-check.** Use the YTBS rule. A re-check needs at least 10 votes after the latest check. The 95% Wilson lower bound of the disagree share must be above 60%. Add a D1 votes table, per-IP limits, and a daily re-check cap. This replaces the timer sweep from D3.
6. **B6. Brand pages.** `/brand/<slug>` shows the average score and the best and worst verdicts. Only brands with 3 or more numbered verdicts get a page.
7. **B7. URL swap.** `chrisputer.tech/dp/<ASIN>` and `/<slug>/dp/<ASIN>` open the saved verdict or the filled `/verify` page. A GET never starts a paid run.
8. **B8. Browser extension.** A panel on Amazon product pages, backed by a read-only JSON endpoint for saved verdicts by ASIN.
9. **B9. Second retire reason `eval-test`** (owner decision). 254 public "best X" rows remain on `/research`. Dry run:
   ```sql
   SELECT COUNT(*) FROM research r
    WHERE r.retired_at IS NULL AND (r.kind IS NULL OR r.kind != 'verification') AND r.status = 'complete'
      AND ( r.query IN ('best ereader','best budget mechanical keyboard','best wireless mouse for productivity',
                        'best noise cancelling headphones','best air fryer','best electric pressure cooker',
                        'best password manager','best cast iron skillet','best robot vacuum for pet hair',
                        'best portable bluetooth speaker','best mesh wifi systems','best standing desk',
                        'best wireless earbuds under $100','best espresso machine under $500','best home nas devices',
                        'best portable charger for iphone','best ergonomic office chair','best gaming headset under $100',
                        'best smart light bulbs','best vacuum for pet hair','best laptop 2026',
                        'best tax software for self employed','best pho in wichita')
         OR r.query LIKE '%unique test%'
         OR r.query GLOB '*[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]*'
         OR date(r.created_at, 'unixepoch') = '2026-08-27' );
   ```
   The list is `eval/golden-queries.json` plus `eval/real-world-benchmark.json`.
10. **B10. Cleanup after the off-limits work lands.**
    - Remove the hub fallback in `routes/pages.js` `handleBestHub`, the `category.js` stubs, the sitemap hub code, and the browse category strip.
    - Remove `FLYWHEEL_DAILY_MAX` from `wrangler.toml`.
    - Add `retired_at IS NULL` to `getRelatedResearch` in `research-page.js`.
    - If latency matters, move the 410 check into the KV-cache path.
    - After 60 days with the flywheel off, delete `keywords.js` and `keyword_queue`.
11. **B11. `issues.md` entries** for the findings in spec section 1. Cover the verify score artifact, the claim-agnostic evidence, paste-a-link, and the two-press hero. Also cover the completed probe rows and the public probe row.
12. **B12. Probe hardening.** Find out why injection probes still create research rows (292 new rows since 2026-09-01, 3 reached complete). Then make `isProbeQuery` (`worker/lib/safety.js`) catch `order by <n>-- -` and quote-digit suffixes. Retire the public probe row "best home nas for 2026'123".
13. **B13. In-flight dedupe** for identical verify submissions (`pending` or `processing` within 30 minutes).
14. **B14. Quick first verdict.** Add a lighter verify config (fewer searches) that answers in under a minute. Then run a full check in the background.
15. **B15. Decide the category-research card** after 30 days of homepage data. If need-shaped runs stay near 0, move the card off the homepage.

Do B10 to B12 as soon as the off-limits files are free, whatever their rank. They are hygiene and security, not growth.
