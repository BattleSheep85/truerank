# /metrics JSON keys

`GET /metrics` returns one JSON snapshot for the dashboard. Code:
`worker/pages/metrics.js`. Test that pins the key names:
`test/integration/metrics.spec.js`.

**Every key is snake_case** (`top_pages`, `affiliate_clicks`, `spent_usd`). Read
these exact names; there are no camelCase aliases.

## Auth

Send `Authorization: Bearer <METRICS_TOKEN>`. The token is the Worker secret
`METRICS_TOKEN` (BWS key `FRANK_METRICS_TOKEN`).

| Status | When |
|---|---|
| 200 | token matches |
| 401 | `{"error":"Unauthorized"}`: missing or wrong token |
| 503 | `{"error":"METRICS_TOKEN not configured"}`: secret not set |

The response has `Cache-Control: no-store`.

## Top-level keys

| Key | Type | Meaning |
|---|---|---|
| `server_now` | integer | server time, unix seconds |
| `budget` | object | this month's spend against the cap (below) |
| `runs` | object | research runs created in the last 30 days (below) |
| `top_pages` | array | the 20 complete pages with the most views (below) |
| `affiliate_clicks` | object | affiliate click counts (below) |
| `guide_clicks` | object | `{guide_slug: count}`, top 20 guides, all time |
| `subscribers` | integer | rows in `subscribers` (0 if the table is missing) |
| `flywheel` | object | `{status: count}` from `keyword_queue` (`{}` if the table is missing) |
| `unserved_demand` | object | queries the site could not serve well (below) |
| `gsc` | object | Google Search Console summary, last 28 days (below) |

### `budget`

| Key | Type | Meaning |
|---|---|---|
| `month` | string | `YYYY-MM` (UTC) |
| `spent_usd` | number | the larger of the D1 ledger and the KV `cost:YYYY-MM` cache |
| `budget_usd` | number | `MONTHLY_BUDGET_USD` (default 60) |
| `remaining_usd` | number | `budget_usd - spent_usd`, 6 decimals; can go negative |
| `pct_used` | number or null | percent, 1 decimal; null when the budget is 0 |

### `runs`

| Key | Type | Meaning |
|---|---|---|
| `window_days` | integer | always 30 |
| `by_status` | object | `{status: count}` (`pending`, `processing`, `complete`, `failed`, `needs_input`) |
| `by_tier` | object | `{tier: count}`; a leftover column, every new run uses one engine config |
| `cost_usd.total` | number | sum of `research.cost_usd` |
| `cost_usd.avg` | number or null | average cost per run that has a cost |
| `cost_usd.counted_runs` | integer | runs with a non-null cost |
| `avg_duration_seconds` | number or null | average `completed_at - created_at` |

### `top_pages[]`

| Key | Type | Meaning |
|---|---|---|
| `slug` | string | page slug |
| `query` | string | the research query |
| `views` | integer | `research.view_count` |
| `clicks` | integer | affiliate clicks on this page's products, all time |
| `ctr_pct` | number or null | `clicks / views` in percent, 1 decimal; null with 0 views |
| `product_count` | integer | products on the page |

### `affiliate_clicks`

| Key | Type | Meaning |
|---|---|---|
| `total` | integer | all clicks ever |
| `last_30d` | integer | clicks in the last 30 days |
| `top_products[]` | array | top 20 products by clicks: `product_id`, `product_name` (or null), `research_slug` (or null), `clicks` |

### `unserved_demand`

| Key | Type | Meaning |
|---|---|---|
| `find_handoffs[]` | array | queries handed to Google from `/find`: `query`, `count` (top 20) |
| `weak_results[]` | array | the 20 newest failed runs or complete runs with fewer than 3 products: `query`, `status`, `product_count` |

### `gsc`

| Key | Type | Meaning |
|---|---|---|
| `available` | boolean | false when there is no GSC data or the query failed |
| `top[]` | array | top 20 queries by impressions: `query`, `clicks`, `impressions`, `position` |
| `opportunities[]` | array | queries with 20 or more impressions at position 5 to 20, same fields |

## Optional diagnostic keys

These appear only when the matching query parameter is `1`. Each holds the call's
result, or `{error}` / `{skipped}` when it fails. A failure never breaks the
snapshot.

| Parameter | Adds key | Does |
|---|---|---|
| `gsc_ingest=1` (with optional `gsc_days=N`, max 480) | `gsc_ingest` | pulls GSC data now instead of waiting for the daily cron |
| `gsc_inspect=1` | `gsc_inspect` | runs the URL Inspection sample |
| `gsc_sitemaps=1` | `gsc_sitemaps` | lists the sitemaps GSC knows |
| `gsc_sites=1` | `gsc_sites` | lists the GSC properties |
| `gsc_submit_sitemap=1` (with optional `gsc_feedpath`) | `gsc_submit_sitemap` | tries to submit the sitemap; expected to answer 403 under the read-only scope |
