# Refocus 2026-10: spec

Date: 2026-10-06. Owner request and intent: `docs/refocus-2026-10/intent.md`. Build steps: `docs/refocus-2026-10/plan.md`.

This spec decides three things:

1. What to remove: the keyword-made "best" reports.
2. How to remove them: hide them, answer 410, and keep the rows.
3. Which YTBS lessons to build now: an honest score, paste a link with saved verdicts, and a verify-first homepage. Decisions that rest on a judgment call carry the mark ASSUMED, with the reason.

## 1. What we found

All numbers come from read-only queries on production D1 on 2026-10-06 (section 8). Code facts come from `d804aeb` plus the working tree.

| Fact | Value |
|---|---|
| Research rows | 1,081 |
| Public rows (`publicResearchFilter`) | 515, and 473 of them start with "best " |
| Rows the SEO flywheel created | 362 (219 public) |
| `keyword_queue` | 340 done, 41 failed, 1 queued, 0 pending |
| Flywheel rows by month | June 121, July 241, August to October 0 |
| Public rows after the flywheel rows leave | 296 (200 listable clusters), 254 still start with "best " |
| Verification rows | 16 in 3 months, 11 complete |
| Claims on the 9 real verified products | 74: 3 verified, 4 partly verified, 3 contradicted, 64 unsubstantiated |
| Verify scores | 0, 0, 17, 20, 20, 20, 24, 26, 27, 29, 50 |
| Accounts, signed-in searches | 0, 0 |
| New ranking rows, 2026-09-01 to 2026-10-06 | 292, mostly injection probes such as `order by 501-- -` (24 rows each) |

Undetected issues:

1. The verify score measures evidence coverage, not honesty. `overallVerdict` (worker/lib/verdict.js) counts an unsubstantiated claim as 0.2. 86% of claims end up unsubstantiated, so most products score about 20 and get "Falls short". Example: Sony WH-1000XM6 scored 26/100.
2. Probable root cause: `topEvidenceForClaim` (worker/engine/verify.js) ignores the claim. Every claim gets the same 15 sources. The stance model sees only the first 1,200 characters of each source.
3. Paste-a-link does not work. A pasted URL becomes the search text and `productUrl` stays empty. A link longer than 200 characters fails validation.
4. The homepage hero takes two presses. It sends the text to `/verify`, and the person must press "Verify it" a second time.
5. The keyword queue is empty. The only remaining flywheel effect is the re-run sweep. The sweep buys up to 2 new runs per day for old reports. Its trigger is a view count that bots inflate (docs/audience-analysis-2026-08.md).
6. The September "traffic climb" is mostly an injection scanner on `POST /api/research`. Three probe rows reached status complete (for example "best foam tips for iems' order by 1000-- -"). One probe-shaped row is public: "best home nas for 2026'123".

## 2. Goals and non-goals

Goals:

- G1. Stop making and refreshing keyword reports.
- G2. Remove keyword-made reports from every list, hub, feed, sitemap, and search that people and crawlers see. Keep the data.
- G3. Make the verify verdict honest. Show a number only when Frank decided enough claims.
- G4. Let a person paste a product link and get a verdict. Reuse a saved verdict at once and free.
- G5. Lead the homepage with that one box.

Non-goals for this run:

- Delete rows, products, claims, or keywords.
- Change the ranking engine, the report page template, or research intake. Those files hold uncommitted work and are off-limits.
- Share button, link-preview images, a verdict sitemap, votes, brand pages, or a browser extension. These are in the plan backlog.

## 3. Decisions

### D1. What counts as an SEO "best" result

Decision: a research row that `runFlywheelTick` created. The rule: a `keyword_queue` row links to it through `research_id`, and `research.query` equals `LOWER(TRIM(keyword))`. That is the exact insert shape of `runFlywheelTick`. The rule matches 362 rows.

The rule leaves out two groups. It leaves out the 8 "clustered" rows. In that case the flywheel attached a keyword to a report that somebody else made, so the query text differs. It also leaves out all verification rows.

Why: provenance is exact and you can audit it. A shape rule ("query starts with best") would also hide real searches such as "best 4k monitor for office work". It would also take 254 rows that tests, evals, audits, and a few people made.

ASSUMED: rows from the eval harnesses, test batches, and the 2026-08-27 audit are not "based on SEO research". They stay public on `/research`, but they leave the homepage (D5).

Change my mind: the owner still sees "best X" lists on `/research` after this ships and wants them gone. Then add a second reason, `eval-test`. Backlog item B9 has the dry-run query.

### D2. Hide, 410, or delete

Decision: keep every row. Mark it with `retired_at` and `retired_reason`. Hide it from every public list. Answer its URL with 410 Gone and a short page that sends people to Verify.

Why: Google never indexed these pages (317 submitted, 0 indexed, 0 clicks ever), so a 410 loses nothing. A page that still answers 200 keeps counting as scaled content in the site-wide quality view. A 410 tells crawlers to drop the URL fast. The rows stay for audit, and one UPDATE undoes the change.

The 410 page carries no ads. AdSense policy forbids ads on error pages, and `htmlPageResponse` always injects the AdSense loader. So the 410 page follows the `notFound()` pattern: plain HTML, no loader.

Change my mind: logs show real human visits (not bots) to retired URLs. Then 301 those URLs to the closest static guide or to `/verify`.

### D3. Flywheel and re-run sweep

Decision: both are off by default. `runFlywheelTick` returns at once unless env `SEO_FLYWHEEL_ENABLED` is `'true'`. The sweep runs inside the tick, so it stops too. The code stays in place and inactive. The default needs no `wrangler.toml` edit, which is off-limits now.

Why the sweep stops too: it refreshes pages nobody reads, and its trigger is a view count that bots inflate. It would also buy new runs for retired reports. A person can still re-run any report with the existing `fresh` flag, and the 14-day cluster cache expires on its own.

ASSUMED: the flag name `SEO_FLYWHEEL_ENABLED`.

Change my mind: human feedback on specific reports. Then replace the timer sweep with a YTBS-style re-check that votes trigger (backlog B5).

### D4. `/best/` hubs, guides, and the "Guides" nav link

Decision: retire every dynamic `/best/:slug` hub, so it answers 404. Keep the 4 hand-written static guides and the "Guides" nav link.

Why: the dynamic hubs are programmatic SEO by design. They are "Best <category>" doorway pages built from the same report rows. The 4 static guides are editorial. The few human clicks in the audience analysis came from their topics (NAS, keyboards).

Constraint: `routes/pages.js` (off-limits) calls `renderCategoryHub`. So `renderCategoryHub` returns null, and the route answers 404. `listCategories` returns an empty list. That empties the sitemap hub list and the browse category strip. Backlog B10 removes the dead code later.

ASSUMED: the static guides are not "SEO research" results. Change my mind: the owner says they are. Then add their paths to `worker/lib/dead-urls.js` as 410 and drop the nav link.

### D5. Homepage

Decision:

- The homepage leads with one Verify box. The box takes a product link or a product name. One press starts the check, or opens the saved verdict.
- The "best X" example chips go.
- The category search stays as a smaller second card with need-shaped wording: "Not sure which product? Describe what you need." Its example chips fill the box. They do not start a paid run.
- The "Recent research" list leaves the homepage. A "Recent verdicts" list takes its place. It shows only when at least 3 verdicts with a number exist.

Why: YTBS works because of one box, one action, and one verdict. Real people typed need-shaped research queries, not "best X". Two examples: "tires for my 2010 mazda 3" and "hiking boot, 10.5 in 4e, 270lb man".

ASSUMED: the example chips paraphrase real queries and drop personal details (for example, body weight). ASSUMED: the `/best/` guides index keeps its "Recent research" list. That page is the rankings area, and it no longer shows keyword reports.

### D6. Which YTBS lessons to build now

Now:

1. One honest score.
2. Paste a link, and get the saved verdict when one exists, with "Checked on <date>".
3. A verify-first homepage with a one-press submit.

Later (the plan backlog ranks them):

- Share button and score in link previews.
- Names for short links (a.co).
- A PWA share target.
- A verdict sitemap and llms.txt.
- Agree and disagree votes with a Wilson re-check.
- Brand pages, the URL-swap trick, and a browser extension.

Why this order: sharing a verdict spreads it. Today the verdict is wrong for most products (D7). So the order is: fix the verdict, make it easy to get, then make it easy to share.

### D7. Honest score

Decision:

- The overall score uses only claims that independent evidence decided: verified, partially verified, or contradicted.
- Unsubstantiated claims count neither for nor against the product.
- There is no number when evidence decided fewer than 2 claims, or fewer than 25% of the claims. The label is then "Not enough independent evidence".
- The page always shows "Frank found independent tests for N of M claims."
- Pages compute the verdict again from the stored claims, so old reports also show the honest verdict.

Why: missing evidence does not count against a product. With the current data, 2 of the 9 real products keep a number: Sony WH-1000XM6 (from its 4 decided claims) and Anker Soundcore Space A40 (2 of 2). The other 7 show "Not enough independent evidence".

The claim-aware evidence fix (plan piece 9) is the real cure. D7 keeps the output truthful until that fix shows results.

ASSUMED: the thresholds 2 claims and 25%.

Change my mind: after piece 9, more than 60% of claims are still unsubstantiated. Then the verify engine needs deeper work before anyone promotes verdict links.

### D8. Product identity for saved verdicts

Decision: one key per product. The key goes in `research.canonical_query` with the prefix `verify:`.

- An Amazon link keys on its ASIN.
- Another link keys on host plus path, without the query string.
- A typed name keys on its sorted, unique, lowercase word tokens. The key keeps numbers and years.

Frank reuses a complete verdict with the same key from the last 30 days. Reuse costs nothing: no quota, no budget check, no queue message, and no new row.

Why: a wrong match shows a person the verdict for a different product. A miss costs one more run. So the key prefers misses. It keeps every number, and it does not stem or drop words. "MacBook Air 2024" and "MacBook Air 2022" stay different.

Why `canonical_query`: verification rows have no products. The ranking cache (`findResearchByCanonicalQuery`), the listings, and related research all require products, so a `verify:` key can never collide with them. No schema change is necessary for this key.

ASSUMED: 30 days. Change my mind: repeat demand for the same products. Then extend the window to 90 days and add a "Check again" button (backlog B3).

ASSUMED: short links (a.co, amzn.to) carry no name and no ASIN. Intake answers 422 with a clear message until backlog B2 reads the name from the page.

## 4. Architecture

### 4.1 Data model: migration 017

Two nullable columns on `research`, then a backfill. No index is necessary. The listing filters already scan the candidate rows, and the 410 check reads by `slug`, which has a unique index.

```sql
ALTER TABLE research ADD COLUMN retired_at INTEGER;   -- unix epoch seconds, NULL = live
ALTER TABLE research ADD COLUMN retired_reason TEXT;  -- 'seo-flywheel'
UPDATE research
   SET retired_at = CAST(strftime('%s','now') AS INTEGER), retired_reason = 'seo-flywheel'
 WHERE retired_at IS NULL
   AND (kind IS NULL OR kind != 'verification')
   AND EXISTS (SELECT 1 FROM keyword_queue k
               WHERE k.research_id = research.id
                 AND LOWER(TRIM(k.keyword)) = research.query);
```

Undo for all rows: `UPDATE research SET retired_at = NULL, retired_reason = NULL WHERE retired_reason = 'seo-flywheel';`

### 4.2 Where each public surface hides retired rows

| Surface | Code path | Mechanism | Plan piece |
|---|---|---|---|
| Homepage and `/best/` recent lists | `home.js` `recentReportsSection` | `publicResearchFilter` | 4 |
| `/research` browse and its page count | `browse.js` through `listable.js` | `publicResearchFilter` | 4 |
| Autocomplete | `routes/pages.js` `handleSearchSuggest` | `publicResearchFilter` | 4 |
| Sitemap, Atom feed, shared lastmod | `sitemap.js` | `publicResearchFilter` | 4 |
| Cluster canonical winner | `db.js` `getClusterWinnerSlug` | `publicResearchFilter` | 4 |
| 14-day cluster cache for new queries | `db.js` `findResearchByCanonicalQuery` | `retired_at IS NULL` | 4 |
| Verify "better alternatives" | `db.js` `findRankingForCategory` | `retired_at IS NULL` | 4 |
| `/reviews` catalog and facets | `product-search.js` `buildProductWhere` | `r.retired_at IS NULL` | 5 |
| `/research/:slug` | `index.js` guard, `retired.js` | 410 page | 3 |
| `/best/:slug` hubs | `category.js` `renderCategoryHub` returns null | 404 | 6 |
| Hub URLs in sitemap, browse category strip | `category.js` `listCategories` returns `[]` | empty | 6 |
| Related research on live report pages | `research-page.js` `getRelatedResearch` | not covered (off-limits file) | backlog B10 |

The cluster-cache filter matters. Without it, a new query that clusters onto a retired row sends the person to a 410 page.

### 4.3 Routes

`/research/:slug` (GET, HEAD): `worker/index.js` calls `isRetiredResearchSlug(env.DB, slug)` before `handleResearchPage`. A true result returns the 410 page. The check runs before the KV page cache, so a cached copy never hides the 410. On any error the check returns false and the report serves as before (fail-open).

`/best/:slug`: no route change. `handleBestHub` serves a static guide when the asset exists. Otherwise it calls `renderCategoryHub`, which now returns null, so the route answers 404.

### 4.4 Verify intake flow (new submission)

1. Read `product` (3 to 2,048 characters).
2. Parse it with `parseProductInput`. The result is `{ kind, name, url, key }`.
3. A link that is not public (internal host, bad URL) gets 400.
4. A link without a name in its path gets 422 with `code: 'name_required'`.
5. Validate the name (3 to 200 characters, at least 3 letters or digits). Then run the existing safety screen on the name.
6. Run the existing burst gate and hourly rate limit.
7. Look up a saved verdict by key. A hit returns `{ id, slug, status: 'completed', reused: true, checkedAt }` at once.
8. Otherwise run the existing budget gate and quota check. Then insert the row with `query = name`, `subject_url = url`, and `canonical_query = key`, and enqueue it.

The resubmit path (`reportId` plus `productUrl`) does not change. The one exception: the queue message uses the stored `row.query` as the product name.

### 4.5 Score

```
decided   = claims with status in {verified, partially-verified, contradicted}
value     = verified 1.0, partially-verified 0.5, contradicted 0.0
weight    = spec 1.5, warranty 1.5, support 1.0, marketing 0.75 (unchanged)
score     = round(100 * sum(value * weight) / sum(weight)) over decided claims
no number = claimCount == 0 or decidedCount < 2 or decidedCount / claimCount < 0.25
```

The score bands do not change.

### 4.6 Homepage order

1. Hero: the Verify box (link or name) and a status line.
2. Second card: "Describe what you need" (category research), with chips that fill the box.
3. Recent verdicts (only with 3 or more numbered verdicts).
4. The static sample readout, how it works, method, guides, and FAQ.
5. Final call to action: a second Verify box.

## 5. Requirements

- R1. The cron starts no keyword research and no re-run sweep unless `SEO_FLYWHEEL_ENABLED` is `'true'`.
- R2. Migration 017 adds `research.retired_at` and `research.retired_reason`. It marks every row that matches rule D1 with reason `seo-flywheel`. It deletes nothing, and a second run changes nothing.
- R3. A GET or HEAD of `/research/<slug>` for a row with `retired_at` set answers 410. The body is a noindex HTML page with no ads and links to `/` and `/best/`. A lookup error serves the report as before.
- R4. No row with `retired_at` set appears on a public surface. The full list is in section 4.2: recent lists, browse, autocomplete, sitemap, feed, lastmod, cluster winners, the cluster cache, verify alternatives, and `/reviews`.
- R5. Every `/best/<slug>` that is not one of the 4 static guides answers 404. The sitemap lists no hub URL. Browse shows no category strip. The 4 static guides answer 200.
- R6. `overallVerdict` returns a number only from decided claims, and only when the thresholds in 4.5 hold. Otherwise it returns `score: null` and the label "Not enough independent evidence".
- R7. Every verify result page, old or new, shows the verdict that `overallVerdict` computes from its stored claims. It shows "N of M claims" and "Checked on <date>". It never prints "0/100" for a missing score.
- R8. The stance check gets sources that Frank ranks and excerpts for the claim under test.
- R9. `POST /api/verify` accepts a product name or a product page link of up to 2,048 characters. A link with a name in its path starts a check, with the link as `subject_url`. A link without a name answers 422 `name_required`. A link to a host that is not public answers 400.
- R10. A complete verification with the same key that finished in the last 30 days comes back at once with `reused: true`. Reuse spends nothing: no quota, no budget gate, no queue message, and no new row.
- R11. The homepage leads with one box for a link or a name. One press starts the check or opens the saved verdict. Without JavaScript, the box still reaches `/verify`.
- R12. The homepage shows no "best X" example and no "Recent research" list. It shows "Recent verdicts" when at least 3 verdicts with a number exist.
- R13. Nothing deletes a row, product, claim, or keyword. One UPDATE undoes the retirement.

## 6. Rollout and deploy risk

A push to `main` is the deploy. GitLab CI runs only `node scripts/run-tests.mjs`, then `wrangler deploy`. CI does not apply migrations and does not run `vitest`.

The dominant cross-piece risk is deploy order. Pieces 4, 5, 11, and 12 read `retired_at`. If they deploy before migration 017 is live in production, every listing query fails with "no such column". So the owner applies 017 to dev and production right after piece 2 merges, and before those pieces merge. The plan rollout checklist has the commands. Piece 3 is fail-open, so it is safe in either order.

Pieces 7 and 8 must ship in the same push. Piece 7 makes new verdicts store `score: null`, and only piece 8 renders that state.

## 7. Risks and known gaps

- 254 public "best X" rows from tests, evals, audits, and people stay on `/research` (D1, backlog B9).
- Related-research links on live report pages can still point at a retired report until B10 changes `research-page.js`.
- The verify engine can stay weak after piece 9. Then most verdicts read "Not enough independent evidence". That result is honest, but it is not yet a product people will share.
- The sitemap XML cache and the homepage edge cache can list a retired row for up to 1 hour after the migration. The report URL itself answers 410 at once.
- The 410 check adds one indexed D1 read per report view. ASSUMED acceptable at the current traffic. If report latency rises by more than 20 ms at p95, move the check into the KV page-cache path (B10).
- `issues.md` is off-limits in this run. The findings in section 1 need entries there later (B11).

## 8. Queries used (read-only, production, 2026-10-06)

```sql
-- flywheel-made rows (rule D1)
SELECT COUNT(*) FROM research r
 WHERE EXISTS (SELECT 1 FROM keyword_queue k
               WHERE k.research_id = r.id AND LOWER(TRIM(k.keyword)) = r.query);          -- 362
-- linked, but made by someone else (clustered)
SELECT COUNT(*) FROM research r
 WHERE EXISTS (SELECT 1 FROM keyword_queue k WHERE k.research_id = r.id)
   AND NOT EXISTS (SELECT 1 FROM keyword_queue k
                   WHERE k.research_id = r.id AND LOWER(TRIM(k.keyword)) = r.query);      -- 8
-- claim outcomes per completed verification
SELECT r.query, r.overall_score, SUM(c.verdict='verified'), SUM(c.verdict='partially-verified'),
       SUM(c.verdict='unsubstantiated'), SUM(c.verdict='contradicted'), COUNT(c.id)
  FROM research r LEFT JOIN claims c ON c.research_id = r.id
 WHERE r.kind = 'verification' AND r.status = 'complete' GROUP BY r.id;
```

The public counts wrapped these predicates in the real `publicResearchFilter('r')` text from `worker/lib/utils.js`.
