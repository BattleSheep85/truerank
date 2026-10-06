/**
 * Product-verification API handlers (Truth Audit pipeline).
 * POST /api/verify — start a new verification job, reuse a saved verdict for
 *   the same product, or resubmit with a product URL after a needs_input ask.
 * GET /api/verify/:id — poll for status/progress/results.
 *
 * Mirrors worker/handlers/research.js's intake pattern (validation, safety
 * screen, rate limit, budget gate, INSERT + queue send) but targets the
 * verification pipeline (worker/pipeline/verify-orchestrator.js) via the
 * queue consumer's `kind: 'verification'` branch. ADDITIVE — does not touch
 * /api/research or any existing route.
 */

import { generateId, getResearchById } from '../lib/db.js';
import { generateSlug } from '../lib/utils.js';
import { screenQuery, rejectionMessage } from '../lib/safety.js';
import { budgetExhausted } from '../pipeline/orchestrator.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { checkBurstGate } from '../lib/burst-gate.js';
import { getSessionUser } from '../lib/auth.js';
import { getQuota, consumeQuota, FREE_VERIFIES } from '../lib/quota.js';
import { parseProductInput, PRODUCT_INPUT_MAX_LEN, PRODUCT_NAME_MAX_LEN } from '../lib/product-link.js';

const PRODUCT_MIN_LEN = 3;
const PRODUCT_MIN_ALNUM = 3;
const DAY_SECONDS = 86400;

/** Saved verdicts younger than this many days answer a new submission. 0 turns reuse off. */
export const VERIFY_REUSE_MAX_AGE_DAYS = 30;

const LINK_BLOCKED_MESSAGE = 'Frank cannot check that link. Paste the address of a public product page.';
const NAME_REQUIRED_MESSAGE = 'That link does not include the product name. Copy the full address from the product page, or type the product name.';

/**
 * Handle POST /api/verify
 * Body: { product: string, productUrl?: string, reportId?: string }
 * - product: a product name, a product page link, or share text with a link.
 * - No reportId: returns a saved verdict for the same product from the last
 *   VERIFY_REUSE_MAX_AGE_DAYS days, else creates a new verification row + enqueues.
 * - reportId + productUrl: resubmits a row stuck in needs_input/failed with
 *   the user-supplied product URL, then re-enqueues.
 */
export async function handleStartVerify(request, env) {
    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const raw = typeof body.product === 'string' ? body.product.trim() : '';
    const rawError = validateRawInput(raw);
    if (rawError) return rawError;

    const bodyUrl = readBodyProductUrl(body.productUrl);
    if (bodyUrl.error) return bodyUrl.error;

    const reportId = typeof body.reportId === 'string' ? body.reportId.trim() : '';
    if (reportId) {
        return startResubmit(request, env, reportId, bodyUrl.url);
    }

    const intake = resolveNewProduct(raw, bodyUrl.url);
    if (intake.error) return intake.error;
    return startNewSubmission(request, env, intake);
}

// Step 1: length rules on the raw input, before any parsing.
function validateRawInput(raw) {
    if (raw.length < PRODUCT_MIN_LEN) {
        return jsonResponse({ error: `Product must be at least ${PRODUCT_MIN_LEN} characters` }, 400);
    }
    if (raw.length > PRODUCT_INPUT_MAX_LEN) {
        return jsonResponse({ error: `Product must be under ${PRODUCT_INPUT_MAX_LEN} characters` }, 400);
    }
    return null;
}

// The optional productUrl body field. Returns { url } or { error }.
function readBodyProductUrl(value) {
    if (value == null || value === '') return { url: null };
    if (!isHttpUrl(value)) {
        return { error: jsonResponse({ error: 'productUrl must be a valid http(s) URL' }, 400) };
    }
    return { url: String(value).trim() };
}

// Step 3: derive name, url, and key from the input, then validate and screen the name.
// Returns { name, productUrl, key } or { error }.
function resolveNewProduct(raw, bodyUrl) {
    const parsed = parseProductInput(raw);
    if (parsed.kind === 'url' && !parsed.url) {
        return { error: jsonResponse({ error: LINK_BLOCKED_MESSAGE }, 400) };
    }
    if (parsed.kind === 'url' && !parsed.name) {
        return { error: jsonResponse({ error: NAME_REQUIRED_MESSAGE, code: 'name_required' }, 422) };
    }
    // A typed name keeps the old length rule on the full text (parseProductInput caps it silently).
    const name = parsed.kind === 'name' ? raw : parsed.name;
    const nameError = validateName(name);
    if (nameError) return { error: nameError };

    // CONTENT SAFETY: deterministic, fail-closed screen allowing product URLs —
    // never create a row, enqueue, or research a blocked query.
    const screen = screenQuery(name, { allowUrl: true });
    if (screen.blocked) {
        return { error: jsonResponse({ error: rejectionMessage(screen.reason), rejected: true, reason: screen.reason }, 422) };
    }
    return { name, productUrl: bodyUrl || parsed.url, key: parsed.key || null };
}

function validateName(name) {
    if (!name || name.length < PRODUCT_MIN_LEN) {
        return jsonResponse({ error: `Product must be at least ${PRODUCT_MIN_LEN} characters` }, 400);
    }
    if (name.length > PRODUCT_NAME_MAX_LEN) {
        return jsonResponse({ error: `Product must be under ${PRODUCT_NAME_MAX_LEN} characters` }, 400);
    }
    if ((name.match(/[a-z0-9]/gi) || []).length < PRODUCT_MIN_ALNUM) {
        return jsonResponse({ error: `Product must contain at least ${PRODUCT_MIN_ALNUM} letters or numbers` }, 400);
    }
    return null;
}

// Wallet-DoS defense. Same generous per-IP velocity cap as /api/research,
// and the same layering: the atomic RL_BURST binding caps concurrency
// (10/60s) in front of the non-atomic KV hourly window.
// Applies to new submissions, reuse hits, and resubmits alike.
// Returns a 429 Response, or null when the caller may proceed.
async function velocityGate(env, clientIp) {
    const rateKey = await ipRateKey('verify', clientIp, env);
    const burst = await checkBurstGate(env.RL_BURST, rateKey);
    const velocity = burst.allowed
        ? await checkRateLimit(env.KV, rateKey, 20, 3600)
        : burst;
    if (velocity.allowed) return null;
    const retryAfter = Math.max(1, Math.ceil((velocity.resetAt - Date.now()) / 1000));
    return jsonResponse(
        { error: 'Too many verification runs from your connection in the last hour. Please try again shortly.' },
        429,
        { 'Retry-After': String(retryAfter) },
    );
}

async function budgetGate(env) {
    if (await budgetExhausted(env)) {
        return jsonResponse({ error: 'Monthly research budget exhausted — resets at the start of next month.' }, 503);
    }
    return null;
}

function clientIpOf(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
}

async function startResubmit(request, env, reportId, productUrl) {
    const blocked = await velocityGate(env, clientIpOf(request)) || await budgetGate(env);
    if (blocked) return blocked;
    return handleResubmit(env, reportId, productUrl);
}

async function startNewSubmission(request, env, intake) {
    const clientIp = clientIpOf(request);
    const throttled = await velocityGate(env, clientIp);
    if (throttled) return throttled;

    // Step 5: a saved verdict costs nothing. No quota, no budget gate, no queue, no row.
    const saved = await lookupSavedVerdict(env.DB, intake.key);
    if (saved) {
        return jsonResponse({ id: saved.id, slug: saved.slug, status: 'completed', reused: true, checkedAt: saved.completed_at });
    }

    const overBudget = await budgetGate(env);
    if (overBudget) return overBudget;

    const sessionUser = await getSessionUser(request, env);
    return handleNewSubmission(env, intake, sessionUser, clientIp);
}

/**
 * Newest complete verification with this key that completed at or after
 * nowSec - VERIFY_REUSE_MAX_AGE_DAYS days. Retired rows never match.
 * Returns { id, slug, completed_at } or null.
 */
export async function findSavedVerdict(db, key, nowSec) {
    if (!key || VERIFY_REUSE_MAX_AGE_DAYS <= 0) return null;
    const since = nowSec - VERIFY_REUSE_MAX_AGE_DAYS * DAY_SECONDS;
    const row = await db.prepare(
        `SELECT id, slug, completed_at FROM research
          WHERE canonical_query = ?1 AND kind = 'verification' AND status = 'complete'
            AND completed_at >= ?2 AND retired_at IS NULL
          ORDER BY completed_at DESC, id DESC LIMIT 1`
    ).bind(key, since).first();
    return row ? { id: row.id, slug: row.slug, completed_at: row.completed_at } : null;
}

// A failed lookup must not block a paid run: log it and treat it as a miss.
async function lookupSavedVerdict(db, key) {
    if (!key) return null;
    try {
        return await findSavedVerdict(db, key, Math.floor(Date.now() / 1000));
    } catch (err) {
        console.error('[verify] saved verdict lookup failed, starting a new run. key:', key,
            'error:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

async function handleNewSubmission(env, intake, sessionUser, clientIp) {
    const { name, productUrl, key } = intake;
    // Free-tier gate: only a brand-new verification submission consumes
    // quota — a needs_input resubmit is a continuation of a run already
    // paid for, so it goes through handleResubmit below untouched.
    if (!sessionUser) {
        const quota = await getQuota(env.KV, 'verify', clientIp, env);
        if (quota.remaining <= 0) {
            return jsonResponse({
                error: 'Free limit reached — create a free account to keep verifying products.',
                code: 'signup_required',
                kind: 'verify',
                limit: FREE_VERIFIES,
            }, 403);
        }
    }

    const id = generateId();
    const slug = generateSlug(name, id);

    await env.DB.prepare(
        `INSERT INTO research (id, slug, query, status, kind, subject_url, canonical_query, created_at)
         VALUES (?, ?, ?, 'pending', 'verification', ?, ?, ?)`
    ).bind(id, slug, name, productUrl, key, Math.floor(Date.now() / 1000)).run();

    try {
        await env.RESEARCH_QUEUE.send({ reportId: id, kind: 'verification', product: name, productUrl });
    } catch (err) {
        console.error('[verify] queue send failed:', err instanceof Error ? err.message : String(err));
        try {
            await env.DB.prepare("UPDATE research SET status = 'failed' WHERE id = ?").bind(id).run();
        } catch { /* best-effort cleanup */ }
        return jsonResponse({ error: 'Could not enqueue verification job — please retry' }, 503);
    }

    if (!sessionUser) {
        await consumeQuota(env.KV, 'verify', clientIp, env);
    }

    return jsonResponse({ id, slug, status: 'pending' });
}

async function handleResubmit(env, reportId, productUrl) {
    if (!productUrl) {
        return jsonResponse({ error: 'productUrl is required to resubmit' }, 400);
    }

    const row = await getResearchById(env.DB, reportId);
    if (!row) {
        return jsonResponse({ error: 'Report not found' }, 404);
    }

    // Guard: only allow the needs_input/failed → pending transition on verification rows.
    // A row in pending/processing/complete or a ranking row must not be clobbered by a stray resubmit.
    const update = await env.DB.prepare(
        `UPDATE research SET subject_url = ?1, status = 'pending'
           WHERE id = ?2 AND status IN ('needs_input', 'failed') AND kind = 'verification'`
    ).bind(productUrl, reportId).run();

    if ((update.meta?.changes ?? 0) === 0) {
        return jsonResponse({ error: 'Report is not awaiting a product URL' }, 409);
    }

    try {
        await env.RESEARCH_QUEUE.send({ reportId, kind: 'verification', product: row.query, productUrl });
    } catch (err) {
        console.error('[verify] resubmit queue send failed:', err instanceof Error ? err.message : String(err));
        try {
            await env.DB.prepare("UPDATE research SET status = 'failed' WHERE id = ?").bind(reportId).run();
        } catch { /* best-effort cleanup */ }
        return jsonResponse({ error: 'Could not enqueue verification job — please retry' }, 503);
    }

    return jsonResponse({ id: reportId, slug: row.slug, status: 'pending' });
}

/**
 * Handle GET /api/verify/:id
 * Returns current status. When needs_input, includes needsUrl + the prompt
 * message (stored in `preview`) so the client can ask for a product URL.
 */
export async function handleVerifyStatus(reportId, env) {
    const row = await getResearchById(env.DB, reportId);
    if (!row) {
        return jsonResponse({ error: 'Report not found' }, 404);
    }

    if (row.status === 'complete') {
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: 'completed',
            overallVerdict: row.overall_verdict ?? null,
            overallScore: row.overall_score ?? null,
        });
    }

    if (row.status === 'needs_input') {
        return jsonResponse({
            id: row.id,
            slug: row.slug,
            status: 'needs_input',
            needsUrl: true,
            message: row.preview || 'We could not find that product’s page. Please paste its URL to continue.',
        });
    }

    if (row.status === 'failed') {
        return jsonResponse({ id: row.id, slug: row.slug, status: 'error' });
    }

    return jsonResponse({ id: row.id, slug: row.slug, status: row.status });
}

// Basic http(s) URL validator (both schemes allowed — user-pasted retailer
// links are frequently plain http on older/regional storefronts; the page
// itself is only ever fetched server-side, never rendered as a live link
// without the sanitizeUrl/isValidHttpsUrl https-only checks downstream).
function isHttpUrl(value) {
    try {
        const u = new URL(String(value));
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            ...extraHeaders,
        },
    });
}
