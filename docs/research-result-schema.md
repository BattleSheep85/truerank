# research.result JSON shape

`research.result` is a TEXT column holding JSON. Its shape depends on the row's
status and kind. Written from the code on 2026-10-18 (CP-429). The test
`test/unit/research-result-shape.test.js` runs real synth outputs through the same
steps and checks them against the ranking shape below. When you change the shape,
change this file and that test together.

## Who writes it, who reads it

| Writer | Shape |
|---|---|
| `persistEngineResult` (`worker/pipeline/orchestrator.js`), for both the Cloudflare engine and the off-Cloudflare worker (`worker/handlers/internal.js`) | ranking result |
| `persistVerificationResult` (`worker/pipeline/verify-orchestrator.js`) | verification result (`kind = 'verification'`) |
| `markRejected` (`orchestrator.js`) | rejection |
| every failure path (`orchestrator.js`, `verify-orchestrator.js`, `jobs.js`, `internal.js`) | error |

| Reader | Reads |
|---|---|
| `worker/handlers/report.js`, `worker/handlers/research.js` | the whole object as `report`; `source_count`, `filtered_count`; `error` on failed rows |
| `worker/pages/research-page.js` | `error`, `buyersGuide`, `methodology` |
| `worker/handlers/chat.js` | `buyersGuide` |
| `worker/pages/home.js`, `worker/pages/verify-page.js`, `worker/handlers/verify.js` | verification result (`claims`, `overall`, `evidenceCount`, `productUrl`) |

The research page draws product cards from the `products` table, not from
`result.products`. `result.products` is the copy the JSON API returns.

## Ranking result (status `complete`, kind NULL)

Built by `validateResearchResult` (`worker/engine/validate.js`), then
`persistEngineResult` adds `query`, `source_count`, and `filtered_count`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `summary` | string | yes | never empty (validation throws), at most 1,200 chars |
| `category` | string | yes | at most 80 chars; `"General"` when the synth gives none |
| `methodology` | string | yes | at most 1,200 chars; may be `""` |
| `products` | array of product | yes | at most 20; ranked 1..n; at least 1 (zero products makes the run fail) |
| `buyersGuide` | object | no | left out when the synth gives no guide content |
| `buyersGuide.howToChoose` | string | with the guide | may be `""` |
| `buyersGuide.pitfalls` | string[] | with the guide | blank strings removed |
| `buyersGuide.marketingToIgnore` | string[] | with the guide | blank strings removed |
| `query` | string | yes | the research query |
| `source_count` | number | yes | sources the engine gathered |
| `filtered_count` | number | yes | always 0 today (kept for the API) |

### Product

| Field | Type | Notes |
|---|---|---|
| `name` | string | at most 120 chars; `"Item N"` when missing |
| `brand` | string | at most 80 chars; may be `""` |
| `price` | number or null | null when no source gives a price (never guessed) |
| `rating` | number or null | editorial score 0 to 5; null when evidence is thin |
| `productUrl` | string | may be `""`; the ASIN resolver can fill an Amazon `/dp/` link |
| `manufacturerUrl` | string | may be `""` |
| `imageUrl` | string | `https://` image file URL or `""`; the image resolver can fill it |
| `pros` | string[] | at most 10, each at most 240 chars |
| `cons` | string[] | same limits; may be empty (the honest synth does not invent cons) |
| `specs` | object of string to string | numbers are turned into strings |
| `metadata` | object of string to string | keys at most 40 chars, values at most 240 |
| `verdict` | string | at most 600 chars |
| `rank` | number | 1..n after the quality gate |
| `bestFor` | string | at most 120 chars; may be `""` |
| `affiliateUrl` | string | optional; only on products the ASIN resolver matched |

Validation also drops products outside the query's category, above a stated price
cap, or rated below 3.5 while 3 stronger picks remain (`validate.js`).

## Rejection (status `failed`)

`{ rejected: true, reason, message, summary, products: [], category: "", methodology: "" }`.
`reason` is the safety reason code; `message` and `summary` hold the same
user-facing text.

## Error (status `failed`)

`{ error: string }`. Readers pass `error` through `safeUserFacingError` before
showing it. Examples: `"No reliable products found for this query."`, the monthly
budget stop message (`jobs.js`), `"Invalid result payload from worker."`, or the
thrown error's message.

## Verification result (status `complete`, kind `verification`)

The `runVerification` return value (`worker/engine/verify.js`), stored whole:
`{ status: "ok", product, productUrl, subjectClaimSources, overall, claims,
evidenceCount, costUsd }`. `overall.label` and `overall.score` are also copied to
the `overall_verdict` and `overall_score` columns. See `verify.js` for the claim
fields; this file does not pin them.

## Rows with no result

`pending`, `processing`, and `needs_input` rows have `result` NULL. Readers use
`parseJsonSafe(row.result, …)` so a NULL or broken value never throws.
