# truerank-research-worker — deploy guide (track 2 / Approach B)

Runs the **parallel research engine off Cloudflare** so research has no
~950-subrequest / 20-min cap and can fan out with high concurrency. The public
site keeps serving from Cloudflare's edge; only *processing* moves to this
worker. Architecture (Approach B):

```
user / flywheel → CF /api/research (inserts a 'pending' research row)
worker          → POST /api/internal/next-job   (atomic claim: pending→processing)
worker          → runParallelEngine  (no CF limits, MAX_CONCURRENCY sub-researchers)
worker          → POST /api/internal/complete   ({result, sources, cost})
CF /complete    → ASIN + images + affiliate tagging + D1 write + IndexNow
```

The CF Worker side is **already deployed** (internal endpoints + `WORKER_SECRET`).
This guide deploys the worker container on the `blackbox` host.

## 1. Ship the code to the host

Dependency-free Node — no `npm install`. Copy the entrypoint + the engine/lib tree:

```bash
sudo mkdir -p /mnt/pods/truerank-research-worker/src
rsync -a --delete ~/projects/web/frank/worker /mnt/pods/truerank-research-worker/src/
cp               ~/projects/web/frank/research-worker.mjs /mnt/pods/truerank-research-worker/src/
# Re-run this rsync to ship engine updates, then restart the container.
```

## 2. Secrets (already in BWS)

Paste these into the Portainer stack's Environment Variables:

| Var | Source |
|---|---|
| `WORKER_SECRET` | BWS `WORKER_SECRET` — **must equal** the CF Worker's `WORKER_SECRET` secret |
| `OPENROUTER_API_KEY` | BWS `OPENROUTER_API_KEY` (TrueRank-Prod) |
| `SERPER_API_KEY` | BWS `SERPER_API_KEY` |

Optional: `MAX_CONCURRENCY` (16), `POLL_INTERVAL` (15), `MAX_SEARCHES` (0 = job config), `CF_BASE_URL`.

## 3. Deploy

`stacks/truerank-research-worker.yml` → deploy via the Portainer REST API flow in
`~/projects/blackbox/CLAUDE.md` (or paste into a new Portainer stack). It needs
only outbound internet (CF + OpenRouter + Serper) — no `postgres-core-net`.

## 4. Cutover — coexist first, then shift load (safe)

**Phase A (zero-risk coexist).** Deploy the worker as-is. It and the CF queue
consumer both claim jobs, but the atomic `pending→processing` claim guarantees
**no double-processing**. The CF consumer (fires on enqueue) will still win most
races, so the worker mostly idles — but this proves the worker is healthy in prod
with no disruption. Watch `docker logs truerank-research-worker`.

**Phase B (shift processing to the worker).** Once Phase A looks clean, set the CF
Worker var `EXTERNAL_WORKER_ENABLED=true` and redeploy: the queue consumer then
acks-without-processing (and the flywheel just inserts pending rows), so the
worker becomes the primary processor with unlimited depth. *(This flag is added
in the CF Worker as part of the cutover; flipping it back to `false` instantly
restores CF-side processing as a fallback.)*

**Rollback:** stop the container (CF resumes processing via the queue consumer,
degraded to the sequential engine + CF caps but fully functional), or set
`EXTERNAL_WORKER_ENABLED=false`.

## 5. Verify

```bash
# seed a job and watch it flow through the worker:
curl -s -X POST https://chrisputer.tech/api/research -H 'Content-Type: application/json' \
  -d '{"query":"best <something fresh>"}'
docker logs -f truerank-research-worker     # [job …] → engine → complete -> 200
# then confirm the research row shows synth_model=gpt-5.4-mini (or extraction-v0
# on the off-CF extraction path) and products in D1.
```

## Live activity feed (off-CF)

The worker streams its progress into the same SSE activity feed CF-side runs use,
via `POST /api/internal/progress` (X-Worker-Secret auth). For each engine event
`research-worker.mjs` fires a best-effort, non-blocking beat carrying a per-job
monotonic step; CF appends it to `progress_log:{id}` (capped at 50) and updates
`progress:{id}`, so the processing page animates live for off-CF runs too. The
posts are fire-and-forget with a short timeout — if the feed is down the report
still completes normally. (This closed the earlier no-op `onEvent` limitation.)
