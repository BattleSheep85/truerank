/**
 * Report-ready notifications: the reason the subscriber list exists.
 *
 * Called from the `won` block of persistEngineResult, which is the single
 * choke point every completion path crosses (queue consumer, cron fallback,
 * flywheel, and the off-Cloudflare worker handoff). The `won` latch also
 * guarantees at most one notify per completion when two processors race.
 *
 * NEVER throws. A dead mail server must not fail a research run. Notices are
 * best effort by product definition, because the report page is the source of
 * truth and it is already committed before this runs.
 */

import { sendMail, mailConfigured } from './mailer.js';
import { reportReadyEmail, SITE_URL } from './email-templates.js';
import { runPool } from './pool.js';

// One notice per subscriber row per hour. A re-research inside the hour is
// almost always the same content, so it stays quiet.
export const NOTIFY_DEDUPE_S = 3600;
// Hard ceiling on eligible rows queried from D1.
export const NOTIFY_MAX_RECIPIENTS = 100;
// Cap on how many emails are dispatched per invocation so notify never blows subrequests.
export const NOTIFY_BATCH_SIZE = 25;
// Parallel Resend API calls. Kept at 2: Resend's default rate limit is about
// 2 requests per second per team, and resend.js retries one 429 only.
export const NOTIFY_CONCURRENCY = 2;
// Overall time ceiling for the notification phase so a slow mail host never stalls the run.
export const NOTIFY_TIME_CEILING_MS = 15_000;

const RECIPIENT_SQL = `SELECT id, email, unsub_token FROM subscribers
 WHERE research_id = ?1
   AND unsubscribed_at IS NULL
   AND confirmed_at IS NOT NULL
   AND (last_notified_at IS NULL OR last_notified_at < ?2)
 ORDER BY id ASC
 LIMIT ?3`;

/** Empty tally, so every exit path returns the same shape. */
function tally(reason) {
    return { sent: 0, failed: 0, skipped: 0, reason: reason ?? null };
}

/**
 * Older rows predate the mailer and may hold no unsubscribe token. Issue one
 * before the first send, otherwise the List-Unsubscribe header would be dead.
 */
async function ensureUnsubToken(env, row) {
    if (row.unsub_token) return row.unsub_token;
    const token = crypto.randomUUID().replace(/-/g, '');
    await env.DB.prepare('UPDATE subscribers SET unsub_token = ?1 WHERE id = ?2 AND unsub_token IS NULL')
        .bind(token, row.id).run();
    return token;
}

/** Send one notice and record the result. Returns 'sent', 'failed' or 'skipped'. */
async function notifyOne(env, row, { query, reportUrl, now }) {
    const token = await ensureUnsubToken(env, row);
    const message = reportReadyEmail({
        query,
        reportUrl,
        unsubUrl: `${SITE_URL}/unsubscribe?token=${token}`,
    });
    const result = await sendMail(env, { to: row.email, ...message });
    if (!result.ok) return result.skipped ? 'skipped' : 'failed';
    await env.DB.prepare('UPDATE subscribers SET last_notified_at = ?1 WHERE id = ?2').bind(now, row.id).run();
    return 'sent';
}

/**
 * Notify confirmed, active subscribers of one research row in bounded concurrent batches.
 *
 * @param {object} env Worker env.
 * @param {{researchId: string, query: string, slug: string}} input
 * @returns {Promise<{sent: number, failed: number, skipped: number, deferred?: number, reason: string|null}>}
 */
export async function notifySubscribersForResearch(env, { researchId, query, slug }) {
    if (!researchId || !slug) return tally('no-target');
    if (!mailConfigured(env)) return tally('not-configured');

    try {
        const now = Math.floor(Date.now() / 1000);
        const { results } = await env.DB.prepare(RECIPIENT_SQL)
            .bind(researchId, now - NOTIFY_DEDUPE_S, NOTIFY_MAX_RECIPIENTS).all();
        const eligible = results || [];
        if (eligible.length === 0) return tally('no-recipients');

        const rows = eligible.slice(0, NOTIFY_BATCH_SIZE);
        const unbatchedDeferred = eligible.length - rows.length;

        const reportUrl = `${SITE_URL}/research/${slug}`;
        const startTime = Date.now();

        const thunks = rows.map((row) => async () => {
            if (Date.now() - startTime >= NOTIFY_TIME_CEILING_MS) {
                return 'deferred';
            }
            return notifyOne(env, row, { query, reportUrl, now })
                .catch((err) => {
                    console.error(JSON.stringify({ where: 'notify', researchId, error: String(err?.message || err) }));
                    return 'failed';
                });
        });

        const outcomes = await runPool(thunks, NOTIFY_CONCURRENCY, (err) => {
            console.error(JSON.stringify({ where: 'notify', researchId, error: String(err?.message || err) }));
            return 'failed';
        });

        const count = (name) => outcomes.filter((outcome) => outcome === name).length;
        const totalDeferred = unbatchedDeferred + count('deferred');
        const counts = { sent: count('sent'), failed: count('failed'), skipped: count('skipped') };
        if (totalDeferred > 0) {
            console.log(JSON.stringify({ where: 'notify', researchId, ...counts, deferred: totalDeferred }));
        } else {
            console.log(JSON.stringify({ where: 'notify', researchId, ...counts }));
        }
        return { ...counts, ...(totalDeferred > 0 ? { deferred: totalDeferred } : {}), reason: null };
    } catch (err) {
        console.error(JSON.stringify({ where: 'notify', researchId, error: String(err?.message || err) }));
        return tally('error');
    }
}
