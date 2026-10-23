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
import { startResearchRun } from './research-run.js';
import { nowEpoch } from './utils.js';

// ASSUMED (CP-352): 3 visitors and 14 days. The window matches the cluster cache.
export const DISAGREE_THRESHOLD = 3;
export const DISAGREE_WINDOW_DAYS = 14;
// The page posts rating 1 for "No" and 5 for "Yes". A direct API rating of 2
// also reads as disagreement.
export const DISAGREE_MAX_RATING = 2;

const WINDOW_SECONDS = DISAGREE_WINDOW_DAYS * 86400;

export async function countDisagreeingVoters(db, reportId) {
    const row = await db.prepare(
        `SELECT COUNT(DISTINCT voter_hash) AS n FROM feedback
          WHERE report_id = ?1 AND voter_hash IS NOT NULL AND rating <= ?2
            AND created_at > datetime('now', ?3)`
    ).bind(reportId, DISAGREE_MAX_RATING, `-${DISAGREE_WINDOW_DAYS} days`).first();
    return Number(row?.n) || 0;
}

// A newer run of the same question (pending, processing or complete) already
// answers the disagreement. A failed one does not.
async function hasNewerRun(db, report) {
    const row = await db.prepare(
        `SELECT 1 AS hit FROM research
          WHERE id != ?1 AND created_at > ?2 AND status != 'failed' AND retired_at IS NULL
            AND (canonical_query = ?3 OR (?4 IS NOT NULL AND ?4 != '' AND squashed_query = ?4))
          LIMIT 1`
    ).bind(report.id, report.created_at, report.canonical_query, report.squashed_query || null).first();
    return Boolean(row);
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

async function isEligible(env, report) {
    if (!report || report.status !== 'complete' || report.retired_at != null) return false;
    if (await countDisagreeingVoters(env.DB, report.id) < DISAGREE_THRESHOLD) return false;
    if (await hasNewerRun(env.DB, report)) return false;
    return !(await budgetExhausted(env));
}

/**
 * Call after a vote is saved. Starts the re-run when the report qualifies.
 * @returns {Promise<boolean>} true when this call started a run.
 */
export async function maybeStartDisagreementRerun(env, report) {
    if (!(await isEligible(env, report))) return false;
    const now = nowEpoch();
    if (!(await claimRerun(env.DB, report.id, now))) return false;

    const spend = await checkGlobalResearchSpend(env);
    if (!spend.allowed) {
        console.log(`[disagreement] site-wide spend gate full, re-run of ${report.id} waits for a later vote`);
        await releaseClaim(env.DB, report.id, now);
        return false;
    }

    // bypassSearchCache: readers disagree with the last gather, so do not
    // replay its cached search answers.
    const run = await startResearchRun(env, {
        query: report.query,
        canonicalQuery: report.canonical_query,
        squashedQuery: report.squashed_query,
        clarifications: report.clarifications,
        bypassSearchCache: true,
    });
    if (!run.ok) {
        await releaseClaim(env.DB, report.id, now);
        return false;
    }
    await env.DB.prepare('UPDATE disagreement_reruns SET rerun_id = ?2 WHERE report_id = ?1')
        .bind(report.id, run.id).run();
    console.log(`[disagreement] ${DISAGREE_THRESHOLD}+ readers disagree with ${report.id}, started re-run ${run.id}`);
    return true;
}
