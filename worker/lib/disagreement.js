/**
 * Disagreement re-run (CP-352). A public caller cannot force a fresh paid
 * run. Instead, readers answer "Does this match what you found?" on the
 * report page (POST /api/feedback). When DISAGREE_THRESHOLD different
 * visitors (salted IP hash) say "No" inside DISAGREE_WINDOW_DAYS, the server
 * starts one fresh run of the same question. A report gets at most one such
 * run per DISAGREE_WINDOW_DAYS (table disagreement_reruns, schema/024).
 * The run stays inside the site-wide hourly spend gate and the monthly budget.
 */

import { budgetExhausted } from './budget.js';
import { checkGlobalResearchSpend } from './spend-gate.js';
import { checkRateLimit } from './rate-limit.js';
import { startResearchRun } from './research-run.js';
import { nowEpoch, canonicalizeQuery, squashQuery, parseJsonSafe } from './utils.js';

// ASSUMED (CP-352): 3 visitors and 14 days. The window matches the cluster cache.
export const DISAGREE_THRESHOLD = 3;
export const DISAGREE_WINDOW_DAYS = 14;
// The page posts rating 1 for "No" and 5 for "Yes". A direct API rating of 2
// also reads as disagreement.
export const DISAGREE_MAX_RATING = 2;

// Site-wide ceiling on disagreement re-runs per day. Votes are cheap to
// fake from many addresses, so this bounds what a vote campaign can spend
// (about $0.60 a day) and keeps it from eating the hourly spend gate.
export const DISAGREE_DAILY_LIMIT = 6;
const DAILY_KEY = 'disagree:global';

const WINDOW_SECONDS = DISAGREE_WINDOW_DAYS * 86400;

/**
 * The network a vote comes from: IPv4 /24 or IPv6 /64. One person with a few
 * addresses on the same line is one voter. Returns null for an unknown IP.
 */
export function voterNetwork(ip) {
    const raw = typeof ip === 'string' ? ip.trim().toLowerCase() : '';
    const v4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
    if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
    if (!raw.includes(':')) return null;
    const [head, tail = ''] = raw.split('::');
    const left = head ? head.split(':') : [];
    const right = raw.includes('::') && tail ? tail.split(':') : [];
    const missing = raw.includes('::') ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array(Math.max(0, missing)).fill('0'), ...right];
    if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
    return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

export async function countDisagreeingVoters(db, reportId) {
    const row = await db.prepare(
        `SELECT COUNT(*) AS n FROM feedback
          WHERE report_id = ?1 AND voter_hash IS NOT NULL AND rating <= ?2
            AND created_at > datetime('now', ?3)`
    ).bind(reportId, DISAGREE_MAX_RATING, `-${DISAGREE_WINDOW_DAYS} days`).first();
    return Number(row?.n) || 0;
}

// A newer run of the same question (pending, processing or complete) already
// answers the disagreement. A failed one does not.
async function hasNewerRun(db, report, cluster) {
    const row = await db.prepare(
        `SELECT 1 AS hit FROM research
          WHERE id != ?1 AND created_at > ?2 AND status != 'failed' AND retired_at IS NULL
            AND (canonical_query = ?3 OR (?4 IS NOT NULL AND ?4 != '' AND squashed_query = ?4))
          LIMIT 1`
    ).bind(report.id, report.created_at, cluster.canonical, cluster.squashed || null).first();
    return Boolean(row);
}

// A report that is itself a recent disagreement re-run cannot start another
// one: the 14-day limit is per question, not per research row.
async function isRecentRerun(db, reportId, now) {
    const row = await db.prepare(
        'SELECT 1 AS hit FROM disagreement_reruns WHERE rerun_id = ?1 AND created_at > ?2 LIMIT 1'
    ).bind(reportId, now - WINDOW_SECONDS).first();
    return Boolean(row);
}

// Old rows may have no canonical_query: derive it the way intake does.
function clusterOf(report) {
    const clar = parseJsonSafe(report.clarifications, {}) || {};
    return {
        canonical: report.canonical_query || canonicalizeQuery(report.query, clar),
        squashed: report.squashed_query || squashQuery(report.query, clar),
    };
}

// Atomic claim: one statement, so two votes that land together cannot both
// start a run. Returns true only for the caller that wrote the claim.
async function claimRerun(db, reportId, now) {
    const row = await db.prepare(
        `INSERT INTO disagreement_reruns (report_id, rerun_id, created_at) VALUES (?1, NULL, ?2)
         ON CONFLICT(report_id) DO UPDATE SET rerun_id = NULL, created_at = excluded.created_at
          WHERE disagreement_reruns.created_at <= ?3
         RETURNING report_id`
    ).bind(reportId, now, now - WINDOW_SECONDS).first();
    return Boolean(row);
}

async function releaseClaim(db, reportId, now) {
    await db.prepare(
        'DELETE FROM disagreement_reruns WHERE report_id = ?1 AND created_at = ?2 AND rerun_id IS NULL'
    ).bind(reportId, now).run();
}

async function isEligible(env, report, cluster, now) {
    if (!report || report.status !== 'complete' || report.retired_at != null) return false;
    if (await countDisagreeingVoters(env.DB, report.id) < DISAGREE_THRESHOLD) return false;
    if (await hasNewerRun(env.DB, report, cluster)) return false;
    if (await isRecentRerun(env.DB, report.id, now)) return false;
    return !(await budgetExhausted(env));
}

// Both ceilings: the daily disagreement cap, then the site-wide hourly gate.
async function spendAllowed(env) {
    const daily = await checkRateLimit(env.KV, DAILY_KEY, DISAGREE_DAILY_LIMIT, 86400, env.DB);
    if (!daily.allowed) return 'daily disagreement re-run cap reached';
    const hourly = await checkGlobalResearchSpend(env);
    return hourly.allowed ? null : 'site-wide spend gate full';
}

/**
 * Call after a vote is saved. Starts the re-run when the report qualifies.
 * @returns {Promise<boolean>} true when this call started a run.
 */
export async function maybeStartDisagreementRerun(env, report) {
    const now = nowEpoch();
    const cluster = report ? clusterOf(report) : null;
    if (!(await isEligible(env, report, cluster, now))) return false;
    if (!(await claimRerun(env.DB, report.id, now))) return false;

    let run = null;
    try {
        const blocked = await spendAllowed(env);
        if (blocked) {
            console.log(`[disagreement] ${blocked}, re-run of ${report.id} waits for a later vote`);
            return false;
        }
        // bypassSearchCache: readers disagree with the last gather, so do not
        // replay its cached search answers.
        run = await startResearchRun(env, {
            query: report.query,
            canonicalQuery: cluster.canonical,
            squashedQuery: cluster.squashed,
            clarifications: report.clarifications,
            bypassSearchCache: true,
        });
    } finally {
        // No run started (gate closed, queue down, or a throw): free the claim
        // so a later vote can try again.
        if (!run?.ok) await releaseClaim(env.DB, report.id, now);
    }
    if (!run.ok) return false;
    await env.DB.prepare('UPDATE disagreement_reruns SET rerun_id = ?2 WHERE report_id = ?1')
        .bind(report.id, run.id).run();
    console.log(`[disagreement] ${DISAGREE_THRESHOLD}+ readers disagree with ${report.id}, started re-run ${run.id}`);
    return true;
}
