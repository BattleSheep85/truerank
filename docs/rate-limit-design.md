# Rate Limiter Atomicity: Design Decision

Status: APPROVED DESIGN, ready to build.
Date: 2026-07-28. Author: architect (Fable).
Resolves: issues.md MED "rate-limit.js atomicity" (deferred twice).

## 1. Problem statement and real blast radius

### 1.1 The defect

`worker/lib/rate-limit.js` (39 lines) implements a sliding window on KV.
It does `kv.get`, filters timestamps, then `kv.put`. There is no atomicity.
N concurrent requests all read the same pre-write state. All N pass.
KV adds a second hole: cross-colo propagation takes up to 60 seconds, so
requests spread across colos do not see each other at all.

The limiter is correct for sequential same-colo traffic. KV gives
read-your-write consistency inside one location. It fails only under
concurrency or cross-colo spread. That is exactly what an attacker sends.

### 1.2 Call sites (verified 2026-07-28)

| Route | Key | Limit | Protects | Cost of one pass |
|---|---|---|---|---|
| POST /api/research (`worker/handlers/research.js:117`) | `research:${ip}` | 20/hr | Money. Each new run costs about $0.05 to $0.10 (LLM + search) | High |
| POST verify (`worker/handlers/verify.js:71`) | `verify:${ip}` | 20/hr | Money. Paid pipeline run | High |
| POST /api/chat (`worker/handlers/chat.js:148`) | `chat:${ip}` | 20/hr | Money. One LLM call, about $0.005 | Low-med |
| Auth signup/login (`worker/handlers/auth.js:29`) | `auth:${ip}` | 10/hr | Security. Credential stuffing, plus PBKDF2 100k iterations of CPU per attempt | CPU |
| GET /go redirect (`worker/handlers/affiliate.js:25`) | `go:${ip}` | 30/hr | Click-fraud damper. Flagged requests still redirect, tag stripped | ~$0 |
| GET /go redirect, site-wide (`worker/lib/affiliate-gate.js`, CP-353, 2026-10-19) | `go:global` (one key, D1 window, KV fallback) | `AFFILIATE_GLOBAL_HOURLY_LIMIT`/hr, 30 | Slow, wide click fraud under the 6/min native gate. Flagged requests still redirect, tag stripped | ~$0 |
| GET /find (`worker/pages/find.js:26`) | `find:${ip}` | 30/hr | Analytics log throttle only. Redirect proceeds either way | ~$0 |

Note: `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_SECONDS` in `wrangler.toml`
`[vars]` are dead config. No code reads them.

### 1.3 What already bounds the damage

1. Monthly budget governor. `budgetExhausted()` in
   `worker/pipeline/orchestrator.js` gates intake on
   MAX(KV `cost:YYYY-MM`, D1 SUM(cost_usd)) against $60.
2. Anonymous lifetime quota. Search is free with no account; accounts remain
   for history and verification features (verification retains a 10-verify
   lifetime quota in `worker/lib/quota.js` for signed-out users). Also racy
   (read-then-write, same defect).
3. Canonical-query clustering. Repeat queries within 14 days return the
   cached page, free and uncounted.
4. Idempotency latches. pending to processing claims and the guarded
   completion UPDATE stop double processing and double cost counting.
5. Turnstile: scaffolded only. `requireTurnstile: false` in
   `worker/lib/tiers.js`. Nothing enforces it at submit today.

### 1.4 The real exploit, in dollars

Both money gates (velocity cap, anon quota) and the budget counters only
register cost AFTER a run completes (1 to 2 minutes). And the CF queue
consumer (`processResearchMessage` in `worker/index.js`) never re-checks
the budget. It claims the row and runs the pipeline. Only the off-CF claim
path and the cron fallback re-check D1 spend.

So the attack is: one IP fires a few hundred to a few thousand parallel
POSTs with distinct junk queries inside about one minute. Every request
reads the same empty KV state. All pass velocity, quota, and budget. All
insert a row and enqueue a job. The queue then drains ALL of them, past
the $60 gate, because the consumer does not re-check.

Concrete blast radius today:

- One burst of ~1,000 to 2,000 admitted runs commits roughly $50 to $200
  of spend. The $60 cap does not stop work already enqueued.
- Every run creates a junk research row and a sitemap entry. SEO pollution
  plus manual cleanup.
- The month's budget is gone in minutes. Every legit user sees 503 until
  month rollover. The availability harm is worse than the dollar harm.

With a working per-IP limiter the same attacker needs about 30 hours and
many IPs to do the same. The monthly cap is the wall either way. The
limiter controls how cheap and how fast the approach to that wall is.

Honest conclusion: the blast radius is bounded (low hundreds of dollars
once, plus a month of downtime), not unbounded. A full architectural
rebuild is NOT justified. But the fix below is small, closes the burst
hole at zero cost, and also closes the consumer overshoot. It is worth
doing. Durable Objects are not needed.

## 2. Options

### Option A: Cloudflare native rate limiting binding

Verified against current docs
(https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/,
fetched 2026-07-28):

- GA. Needs wrangler >= 4.36. Repo has 4.44.0, CI pins wranglerVersion '4'.
- Config is `[[ratelimits]]` with `name`, `namespace_id`, and a `simple`
  table of `limit` and `period`. Period must be 10 or 60 seconds. No
  hourly period exists.
- Counting is per Cloudflare location, not global. Docs call it
  "permissive, eventually consistent" and not an accounting system.
- `limit({ key })` returns only `{ success }`. No remaining, no resetAt.
- No charge appears on any pricing page. It is a free runtime primitive.
- Local support: the Miniflare-backed vitest pool simulates the binding.
  Evidence: cloudflare/workers-sdk issue #14392 (June 2026) reports that
  the test `reset()` helper does not CLEAR ratelimit state, which confirms
  the binding itself runs in the pool. Tests must use unique keys per test
  instead of relying on reset.

Key insight that decides this design: per-IP limits only ever defend
against a single source. A single source lands on a single colo. So
per-colo atomicity equals global atomicity for this threat. An attacker
spread across colos necessarily has many IPs, and a per-IP limiter passes
them all even when globally atomic. Global counting buys nothing here.

The 60-second ceiling means the binding cannot replace the hourly windows.
It can cap CONCURRENCY. Layer it in front of the existing KV window: the
binding admits at most ~10 per key per minute, which serializes traffic
enough that the KV read-then-write window counts correctly. The combined
limiter enforces the hourly caps with a worst-case overshoot of a small
multiple of the burst limit, not thousands.

### Option B: Durable Object counter

One DO per subject key via `idFromName(key)`, atomic in-memory or SQLite
sliding window, exact `{allowed, remaining, resetAt}`.

Config it would need (current syntax, verified against
https://developers.cloudflare.com/durable-objects/get-started/ and the
migrations reference, 2026-07-28): a class export plus

```toml
[[durable_objects.bindings]]
name = "RATE_LIMITER_DO"
class_name = "RateLimiterDO"

[exports.RateLimiterDO]
type = "durable-object"
storage = "sqlite"
```

(The legacy `[[migrations]]` array with `tag = "v1"` and
`new_sqlite_classes = ["RateLimiterDO"]` still works for old Workers. New
adoptions use the `exports` map. Deletion is an `exports` tombstone with
`state = "deleted"` and permanently destroys the namespace data.)

Pricing (Workers Paid, from
https://developers.cloudflare.com/durable-objects/platform/pricing/,
fetched 2026-07-28): requests 1M/month included then $0.15/M. Duration
400,000 GB-s included then $12.50/M GB-s, billed at 128 MB while active
or idle-but-not-hibernatable. Idle hibernation-eligible objects bill
nothing. SQLite rows written 50M/month included.

Cost math, one DO request per rate check:

- 10k checks/month: requests $0 (inside 1M). Duration worst case 10k
  activations x 10s idle x 0.125 GB = 12,500 GB-s, inside 400k. Total $0.
- 1M checks/month: requests at the included boundary, $0.15 per further
  million. Duration worst case 1M x 10s x 0.125 GB = 1.25M GB-s, so
  850k over x $12.50/M = about $10.60/month. Realistic (hibernation
  eligible, clustered traffic) under $1. Total $0 to $11/month.

"One instance per client IP is unbounded instances" is true but is not
the cost problem. Cost scales with requests and duration, not instance
count. Storage for a million IPs is a few hundred MB, inside the 5
GB-month allowance. The real costs are: one extra network hop per
request (1 to 5 ms same-colo, up to ~150 ms if the DO was created far
away), an exported class in the deploy surface forever, and the exports
migration dance the team explicitly fears. Testable: yes,
`@cloudflare/vitest-pool-workers` supports DOs (`runInDurableObject` in
`cloudflare:test`), and ^0.9.0 is current.

Verdict: correct but overkill. Its only advantage over Option A is
global exactness, which section 2/Option A shows is worthless for per-IP
keys. Not worth the migration surface.

### Option C: Keep KV, mitigate elsewhere

Variants considered:

1. Atomic D1 fixed-window counter. One statement:
   `INSERT ... ON CONFLICT(bucket) DO UPDATE SET count = count + 1 ... RETURNING count`.
   D1 is single-primary, so this is globally atomic. Zero new bindings,
   zero wrangler.toml change, trivially testable under the existing
   Miniflare D1 harness. Cost $0 at any realistic volume (50M rows
   written/month included). Downside: one primary-region write round trip
   (10 to 50 ms and up) added to every checked request, a new table plus
   cron cleanup, and fixed windows allow 2x at a boundary. This is the
   best fallback if the native binding disappoints.
2. Enforce Turnstile on research/verify submit. Strongest anti-bot
   control, already scaffolded. But it is a product decision (adds user
   friction) and does not fix chat or auth. Hold as escalation if abuse
   is actually observed.
3. Accept softness everywhere. Rejected: section 1.4 shows a cheap,
   scriptable, single-IP wallet drain plus month-long outage.

### Comparison

| Criterion | A: native binding + KV | B: Durable Object | C1: D1 counter |
|---|---|---|---|
| Closes the concurrent-burst hole | Yes (per colo = per source) | Yes (global) | Yes (global) |
| Hourly windows | Via existing KV layer | Native | Native |
| Exact remaining/resetAt | No (synthesized on block) | Yes | Yes |
| $/month at 10k checks | $0 | $0 | $0 |
| $/month at 1M checks | $0 | $0 to ~$11 | $0 |
| Added latency per request | ~0 ms (in-colo) | 1 to 150 ms | 10 to 50+ ms |
| wrangler.toml change | 5-line binding | Binding + exports migration | None |
| Reversibility | Delete block, total | Exports tombstone, data destroyed, config dance | Drop table |
| Miniflare testability | Yes (workers-sdk#14392 caveat: no reset between tests) | Yes | Yes (already used) |
| New deploy surface | None | Exported class forever | One schema migration |

## 3. Recommendation

Option A, layered, plus one consumer-side budget re-check. Precisely:

1. Add ONE `[[ratelimits]]` binding, 10 per 60 s, keyed per route+IP, as a
   burst gate IN FRONT of the existing KV hourly window on the four
   checked POST paths: research, verify, chat, auth.
2. Leave `go:` and `find:` on plain KV. They are cheap abuse dampers.
   Softness there costs nothing.
3. Add a `budgetExhausted()` re-check in the two queue message processors
   before running a claimed job. This converts the blast radius from
   "whatever was admitted" to "budget plus in-flight", about $60 + a few
   dollars, no matter what intake missed.
4. Do NOT adopt Durable Objects. Record the decision in issues.md.

What would change my mind:

- If limits must become per-USER billing-grade caps (paid plans, hard
  entitlement counts), move that path to the D1 atomic counter (C1) or a
  DO. Accounting needs global exactness. Abuse damping does not.
- If logs later show paced multi-colo abuse from stable IPs defeating the
  layered limiter, escalate to Turnstile on submit (C2).
- If the Miniflare ratelimit simulator cannot support the integration
  tests in practice, build C1 instead. It is the drop-in second choice.

## 4. Implementation spec

### 4.1 wrangler.toml (exact block to append)

```toml
# Burst gate for the checked POST paths (research/verify/chat/auth).
# Atomic per colo = atomic per attacking source. Layered in front of the
# KV hourly window, which stays the volume ceiling. Free, GA, wrangler >= 4.36.
[[ratelimits]]
name = "RL_BURST"
namespace_id = "1001"
[ratelimits.simple]
limit = 10
period = 60
```

`namespace_id` is an arbitrary string unique inside this Worker. No
dashboard resource exists. No `[[migrations]]` entry, no exported class.

### 4.2 New file: `worker/lib/burst-gate.js` (~45 lines)

```js
/**
 * Burst gate over the native Workers rate limiting binding (RL_BURST).
 * Caps per-key CONCURRENCY (10/60s) in front of the KV hourly window in
 * worker/lib/rate-limit.js, which stays the volume ceiling. The binding
 * is atomic per colo, which equals per attacking source for per-IP keys.
 * FAIL-OPEN by design: a missing binding (plain-Node unit runs, stale
 * local config) or a binding error must never block traffic. The KV
 * layer behind it still enforces the hourly cap.
 */

export const BURST_RESET_MS = 60_000;

export async function checkBurstGate(limiter, key) {
    if (!limiter || typeof limiter.limit !== 'function') {
        return { allowed: true, remaining: null, resetAt: null };
    }
    try {
        const { success } = await limiter.limit({ key });
        if (success) return { allowed: true, remaining: null, resetAt: null };
        return { allowed: false, remaining: 0, resetAt: Date.now() + BURST_RESET_MS };
    } catch (err) {
        console.error('[burst-gate] limit() failed:', err instanceof Error ? err.message : String(err));
        return { allowed: true, remaining: null, resetAt: null };
    }
}
```

Contract: callers only ever surface the BLOCK shape, and that shape is
exactly the existing `{allowed, remaining, resetAt}` contract with
numbers. `checkRateLimit` in `worker/lib/rate-limit.js` is untouched.
The `null` fields on the allow path are never read (call sites replace
the result with the KV check, see 4.3).

### 4.3 Call-site changes (four files, same pattern)

Pattern (immutable, no reassignment):

```js
import { checkBurstGate } from '../lib/burst-gate.js';

const key = `research:${clientIp}`;
const burst = await checkBurstGate(env.RL_BURST, key);
const velocity = burst.allowed
    ? await checkRateLimit(env.KV, key, 20, 3600)
    : burst;
```

Requests the burst gate blocks never touch KV, so they do not consume
hourly quota. Exact edits:

1. `worker/handlers/research.js` line ~117: wrap `research:${clientIp}`,
   KV args stay `(env.KV, key, 20, 3600)`. The 429 + Retry-After branch
   is unchanged (`resetAt` is always a number on block).
2. `worker/handlers/verify.js` line ~71: same, key `verify:${clientIp}`.
3. `worker/handlers/chat.js` line ~148: same, key `chat:${ip}`, KV args
   `(env.KV, key, 20, 3600)`. Caller reads only `.allowed`. Unchanged.
4. `worker/handlers/auth.js` `authRateLimited()` line ~29: same, key
   `auth:${ip}`, KV args `(env.KV, key, 10, 3600)`.

Do NOT touch `worker/handlers/affiliate.js` or `worker/pages/find.js`.

### 4.4 Queue consumer budget re-check (`worker/index.js`)

In `processResearchMessage`, after the pending-to-processing claim
succeeds and before `runResearchPipeline`:

```js
if (await budgetExhausted(env)) {
    await env.DB.prepare(
        `UPDATE research SET status = 'failed', result = ?1, completed_at = ?2
           WHERE id = ?3 AND status = 'processing'`,
    ).bind(
        JSON.stringify({ error: 'Monthly research budget exhausted.' }),
        Math.floor(Date.now() / 1000),
        reportId,
    ).run();
    message.ack();
    return;
}
```

Same block in `processVerificationMessage`. Import `budgetExhausted`
next to the existing orchestrator imports. This is the dollar bound: a
flood that slips past intake dies at the consumer once real spend lands.
Edge cases: `budgetExhausted` already swallows KV errors and returns a
D1-backed answer, and the guarded UPDATE keeps the idempotency latch
semantics. A legit run enqueued seconds before exhaustion fails with an
honest message instead of silently spending past the cap. Accepted.

### 4.5 Fallback behavior (must not break anything)

- Deployed worker, binding present: full layered behavior.
- `wrangler dev` with the new toml: workerd simulates the binding.
- Plain Node (`node scripts/run-tests.mjs`): handlers are not exercised
  there, and `checkBurstGate` unit tests pass mock limiter objects.
- Miniflare/vitest: the pool reads `wrangler.toml` (`configPath` in
  `vitest.config.js`), so `env.RL_BURST` exists in integration tests.
- Any environment where the binding is missing or throws: fail-open,
  KV layer still enforces the hourly cap, one console.error.

### 4.6 Housekeeping (same PR)

- issues.md: mark the MED atomicity item `[x]` with a one-line pointer to
  this doc. Add a line for the consumer re-check fix.
- Optional one-liner: delete dead `RATE_LIMIT_MAX` and
  `RATE_LIMIT_WINDOW_SECONDS` from `[vars]` (no code reads them).

## 5. Test plan

### 5.1 Unit (`test/unit/burst-gate.test.js`, register in `scripts/run-tests.mjs`)

Export `runBurstGateTests()` returning `{passed, failed, failures}` like
the other suites. Assert:

1. Missing binding returns `{allowed: true}` (fail-open).
2. Binding object without `.limit` returns `{allowed: true}`.
3. `limit()` resolving `{success: true}` returns allowed with null fields.
4. `{success: false}` returns `{allowed: false, remaining: 0}` and
   `resetAt` within `[now + 59s, now + 61s]`.
5. `limit()` rejecting returns `{allowed: true}` (fail-open) and does not
   throw.
6. The key passes through to `limit({ key })` unchanged (spy mock).

### 5.2 Integration (`test/integration/`, Miniflare)

Extend `test/integration/research.spec.js` (the velocity-cap spec) and
add cases to `verify-route.spec.js`:

1. Concurrent burst: `Promise.all` of 30 POST /api/research with the same
   `CF-Connecting-IP` and distinct junk queries. Assert admitted count
   (non-429 responses) is <= the burst limit plus a small epsilon
   (assert <= 15, expected ~10). Today this test admits ~30, which is
   the regression proof.
2. Burst-blocked response is 429 with a `Retry-After` header of about 60.
3. Sequential paced requests still hit the hourly KV cap (existing tests
   keep passing, contract stable).
4. Consumer re-check: seed KV `cost:YYYY-MM` above budget, deliver a
   queue message for a pending row, assert the row flips to `failed` with
   the budget message and the pipeline did not run.
5. Auth: 12 parallel signups from one IP, assert <= burst limit pass.

Harness caveats the builder must respect: the ratelimit binding state
does NOT clear between tests (workers-sdk issue #14392, the `reset()`
helper skips ratelimit bindings). Use a UNIQUE fake IP per test case via
the `CF-Connecting-IP` header. The local simulator is single-colo, which
is exactly the topology the burst gate assumes.

Verification commands: `node scripts/run-tests.mjs` then
`npx vitest run`. Both must be green.

## 6. Rollback

Full revert is one commit that removes: the `[[ratelimits]]` block, the
`checkBurstGate` import + wrap at the four call sites, the consumer
re-check blocks, and the two test files. Push to main redeploys the old
behavior exactly. There is:

- no data to migrate or destroy (the binding is stateless config),
- no Durable Object migration to unwind (none was created, this is a
  deliberate benefit of Option A over Option B),
- no schema change (the D1 counter variant was not adopted).

Partial rollback also works: deleting only the `[[ratelimits]]` block
while leaving the code deployed is safe, because `checkBurstGate`
fail-opens when `env.RL_BURST` is undefined and the KV layer keeps
enforcing the hourly caps.

For the record, if Option B had been chosen, rollback would require an
`[exports.RateLimiterDO]` tombstone with `state = "deleted"`, which
permanently destroys the namespace and cannot be reversed. That
asymmetry is part of why Option A wins.
