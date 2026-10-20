/**
 * Monthly budget governor: the month's spend (D1 ledger plus a KV cache) and
 * the cap from env.MONTHLY_BUDGET_USD. Lives in lib (not the pipeline) so
 * handlers and lib modules can gate on the budget without importing the
 * research orchestrator (CP-819).
 */

import { nowEpoch, monthKey } from './utils.js';

// Monthly spend ceiling default; overridden by env.MONTHLY_BUDGET_USD.
const DEFAULT_MONTHLY_BUDGET_USD = 60;

/**
 * Add this run's cost to the month's spend. The add is one atomic D1 upsert on
 * monthly_spend (schema/018), so runs that finish together never lose a cost
 * (CP-375). A month's first row is seeded with the spend KV already holds, so
 * costs from before the migration are kept. KV keeps its own running total
 * (old read-add-put, used alone when D1 fails) and never drops below the D1
 * total, so costs counted during a D1 outage survive the recovery. The gates
 * read MAX(KV, D1). 30-day TTL so old months age out. NaN/zero costs are no-ops.
 */
export async function incrementMonthlyCost(env, cost) {
    if (!Number.isFinite(cost) || cost <= 0) return;
    const month = monthKey();
    const key = `cost:${month}`;
    let kvBefore = 0;
    try { kvBefore = Number(await env.KV.get(key)) || 0; } catch { kvBefore = 0; }
    let ledger = 0;
    try {
        const row = await env.DB.prepare(
            `INSERT INTO monthly_spend (month, total_usd, updated_at) VALUES (?1, ?4 + ?2, ?3)
             ON CONFLICT(month) DO UPDATE SET total_usd = total_usd + ?2, updated_at = ?3
             RETURNING total_usd`
        ).bind(month, cost, nowEpoch(), kvBefore).first();
        ledger = Number(row?.total_usd) || 0;
    } catch (err) {
        console.error('[budget] D1 monthly spend add failed, using KV counter:', err instanceof Error ? err.message : String(err));
    }
    try {
        const total = Math.max(kvBefore + cost, ledger);
        await env.KV.put(key, String(total), { expirationTtl: 30 * 86400 });
    } catch (err) {
        console.error('[budget] monthly cost update failed:', err instanceof Error ? err.message : String(err));
    }
}

// Month-to-date spend from the D1 monthly_spend ledger (every cost, including
// chat and failed runs). 0 when the row or table is missing.
export async function monthlyLedgerUsd(env, month = monthKey()) {
    try {
        const row = await env.DB.prepare('SELECT total_usd FROM monthly_spend WHERE month = ?1')
            .bind(month).first();
        return Number(row?.total_usd) || 0;
    } catch { return 0; }
}

// Month-to-date spend from D1: the larger of the ledger and SUM(cost_usd) over
// completed research rows. Both are race-free. The research sum covers costs
// recorded before the ledger existed (the month migration 018 shipped).
export async function monthlySpendUsd(env) {
    const [ledger, research] = await Promise.all([monthlyLedgerUsd(env), monthlyResearchSumUsd(env)]);
    return Math.max(ledger, research);
}

async function monthlyResearchSumUsd(env) {
    try {
        const d = new Date();
        const start = Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
        const row = await env.DB.prepare(
            'SELECT COALESCE(SUM(cost_usd), 0) AS total FROM research WHERE completed_at >= ?1'
        ).bind(start).first();
        return Number(row?.total) || 0;
    } catch { return 0; }
}

export function monthlyBudgetUsd(env) {
    // An explicit MONTHLY_BUDGET_USD=0 is a kill switch: with spend always >= 0,
    // the governor's `spent >= budget` check refuses every new run (503). Only an
    // unset, empty, negative, or non-numeric value falls back to the default.
    const raw = env.MONTHLY_BUDGET_USD;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return DEFAULT_MONTHLY_BUDGET_USD;
    }
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MONTHLY_BUDGET_USD;
}

// Authoritative budget gate for intake (POST /api/research, /api/chat). The KV
// counter (cost:YYYY-MM) is fast and holds costs counted while D1 was down, but
// can lose a concurrent add; the D1 spend (ledger, or research SUM) is race-free. Gating on
// MAX(KV, D1) keeps intake, the off-CF claim path and the cron fallback in step.
// Short-circuits on KV to avoid a D1 query on every request when already capped.
export async function budgetExhausted(env) {
    const budget = monthlyBudgetUsd(env);
    if (budget <= 0) return true; // MONTHLY_BUDGET_USD=0 kill switch
    let kv = 0;
    try { kv = Number(await env.KV.get(`cost:${monthKey()}`)) || 0; } catch { kv = 0; }
    if (kv >= budget) return true;
    const d1 = await monthlySpendUsd(env);
    return Math.max(kv, d1) >= budget;
}
