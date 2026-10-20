/**
 * Email capture handler.
 * POST /api/subscribe  body: { email, researchId? }
 *
 * Records an opt-in to be notified when a research report completes or is
 * re-run, then starts the double opt-in cycle: the address gets one small
 * confirmation mail and receives nothing else until it clicks the link.
 *
 * The response is always the same generic {ok:true} on well-formed input, in
 * every state (new, repeat, confirmed, cooling down). That keeps the endpoint
 * free of an email-enumeration surface. While mail is off (not switched on, or
 * no SMTP secrets) it adds mail:'off', the same for every address, so the
 * form does not promise a mail that will never come (CP-812). A skipped send
 * stamps nothing, so the visitor's next submit after mail is on sends it.
 *
 * Abuse layers, outermost first: burst gate per IP, hourly window per IP,
 * per-address 24 h cooldown, per-address lifetime cap, double opt-in, and the
 * global MAIL_DAILY_CAP governor inside the mailer.
 */

import { checkBurstGate } from '../lib/burst-gate.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { decideSubscribeAction } from '../lib/subscribe-flow.js';
import { sendMail, mailConfigured } from '../lib/mailer.js';
import { confirmationEmail, SITE_URL } from '../lib/email-templates.js';

// Pragmatic, deliberately-not-RFC-5322 email check. We only need to reject
// obvious junk before it hits the DB; real deliverability is proven by the
// confirmation click. <=254 chars is the SMTP address length limit.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254;
const RESEARCH_ID_RE = /^[a-z0-9]{16}$/;
// Hourly volume ceiling per IP. The burst gate in front of it is atomic.
const SUBSCRIBE_PER_HOUR = 5;
const SUBSCRIBE_WINDOW_S = 3600;

function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...headers,
        },
    });
}

function newToken() {
    return crypto.randomUUID().replace(/-/g, '');
}

/** Read every row this address already owns, across all reports. */
async function readRowsForEmail(db, email) {
    const { results } = await db.prepare(
        `SELECT id, research_id, confirmed_at, unsubscribed_at, confirm_sent_at, confirm_send_count, confirm_token
           FROM subscribers WHERE email = ?1`,
    ).bind(email).all();
    return results || [];
}

/** Insert the new pair. Returns its row id, even when a race won the insert. */
async function insertRow(db, { email, researchId, now, confirmToken, confirmedAt }) {
    const inserted = await db.prepare(
        `INSERT OR IGNORE INTO subscribers
            (email, research_id, created_at, unsub_token, confirm_token, confirmed_at, confirm_send_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0) RETURNING id`,
    ).bind(email, researchId, now, newToken(), confirmToken, confirmedAt).first();
    if (inserted?.id != null) return inserted.id;
    const existing = await db.prepare(
        'SELECT id FROM subscribers WHERE email = ?1 AND research_id IS ?2',
    ).bind(email, researchId).first();
    return existing?.id ?? null;
}

/**
 * Apply the decided action with parameterized statements.
 * Returns the row id and the confirmation token the mail should carry.
 */
async function applyAction(db, plan, rows, { email, researchId, now }) {
    if (plan.action === 'noop') return { rowId: plan.rowId, confirmToken: null };

    if (plan.action === 'insert-confirmed' || plan.action === 'insert-unconfirmed') {
        const confirmToken = plan.action === 'insert-unconfirmed' ? newToken() : null;
        const confirmedAt = plan.action === 'insert-confirmed' ? now : null;
        const rowId = await insertRow(db, { email, researchId, now, confirmToken, confirmedAt });
        return { rowId, confirmToken };
    }

    if (plan.action === 'reactivate') {
        const confirmToken = newToken();
        await db.prepare(
            `UPDATE subscribers SET unsubscribed_at = NULL, confirmed_at = NULL,
                    confirm_token = ?1, confirm_send_count = 0 WHERE id = ?2`,
        ).bind(confirmToken, plan.rowId).run();
        return { rowId: plan.rowId, confirmToken };
    }

    // resend: keep the token already in the reader's inbox when there is one.
    const current = rows.find((row) => row.id === plan.rowId);
    const confirmToken = current?.confirm_token || newToken();
    if (!current?.confirm_token) {
        await db.prepare('UPDATE subscribers SET confirm_token = ?1 WHERE id = ?2').bind(confirmToken, plan.rowId).run();
    }
    return { rowId: plan.rowId, confirmToken };
}

/**
 * Send the confirmation mail and record it. The counter moves only for the
 * target row, and the cooldown stamp moves for the whole address, so the
 * lifetime cap counts real messages and the cooldown holds address-wide.
 *
 * Returns the mailer outcome so the caller can log a lost message. A send that
 * fails or is skipped stamps NOTHING, so the 24 h cooldown and the lifetime
 * cap both stay unspent and the very next submit retries the mail.
 */
async function sendConfirmation(env, { email, rowId, confirmToken, researchId, now }) {
    const research = researchId
        ? await env.DB.prepare('SELECT query FROM research WHERE id = ?1').bind(researchId).first().catch(() => null)
        : null;
    const message = confirmationEmail({
        query: research?.query || null,
        confirmUrl: `${SITE_URL}/confirm?token=${confirmToken}`,
    });
    const result = await sendMail(env, { to: email, ...message });
    if (!result.ok) return result; // leave confirm_sent_at alone so the next submit retries
    await env.DB.prepare(
        `UPDATE subscribers
            SET confirm_sent_at = ?1,
                confirm_send_count = confirm_send_count + (CASE WHEN id = ?2 THEN 1 ELSE 0 END)
          WHERE email = ?3`,
    ).bind(now, rowId, email).run();
    return result;
}

/**
 * The response is the same generic {ok:true} on every path, by design, so a
 * lost confirmation is invisible to the visitor and invisible in the database.
 * This line is the only signal that it happened. The address never enters the
 * log: the mailer logs its own hashed tag on the same request, and the row id
 * traces the rest. `retryable` records that nothing was spent, so the next
 * submit sends again.
 */
function logUndeliveredConfirmation(outcome, rowId) {
    const record = JSON.stringify({
        where: 'subscribe',
        step: 'confirm-send',
        ok: false,
        rowId,
        retryable: true,
        skipped: outcome.skipped ?? null,
        error: outcome.error ?? null,
    });
    // A skip is a configured decision. An error is a defect. Keep them apart.
    if (outcome.skipped) console.log(record);
    else console.error(record);
}

/** Read and validate the request body. Returns either `error` or the fields. */
async function readBody(request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return { error: jsonResponse({ ok: false, error: 'invalid_json', message: 'We could not read your request. Please try again.' }, 400) };
    }
    if (!body || typeof body !== 'object') {
        return { error: jsonResponse({ ok: false, error: 'invalid_body', message: 'Invalid request.' }, 400) };
    }
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || email.length > EMAIL_MAX_LEN || !EMAIL_RE.test(email)) {
        return { error: jsonResponse({ ok: false, error: 'invalid_email', message: 'Please enter a valid email address.' }, 400) };
    }
    // researchId is optional; when present it must match the 16-character [a-z0-9]
    // id shape generated by generateId(). When absent/empty, normalize to NULL
    // so a general subscription dedupes correctly against UNIQUE(email, research_id).
    let researchId = null;
    if (body.researchId !== undefined && body.researchId !== null) {
        if (typeof body.researchId !== 'string') {
            return { error: jsonResponse({ ok: false, error: 'invalid_research_id', message: 'Invalid research ID.' }, 400) };
        }
        const trimmed = body.researchId.trim();
        if (trimmed) {
            if (!RESEARCH_ID_RE.test(trimmed)) {
                return { error: jsonResponse({ ok: false, error: 'invalid_research_id', message: 'Invalid research ID.' }, 400) };
            }
            researchId = trimmed;
        }
    }
    return { email, researchId };
}

export async function handleSubscribe(request, env) {
    if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: 'method_not_allowed', message: 'Method not allowed.' }, 405);
    }

    // This endpoint now causes real outbound mail, so it is rate limited on the
    // same two layers the research intake uses.
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = await ipRateKey('subscribe', clientIp, env);
    const burst = await checkBurstGate(env.RL_BURST, rateKey);
    const velocity = burst.allowed
        ? await checkRateLimit(env.KV, rateKey, SUBSCRIBE_PER_HOUR, SUBSCRIBE_WINDOW_S, env.DB)
        : burst;
    if (!velocity.allowed) {
        const retryAfter = Math.max(1, Math.ceil((velocity.resetAt - Date.now()) / 1000));
        return jsonResponse(
            { ok: false, error: 'rate_limited', message: 'Too many signups from your connection. Please try again shortly.' },
            429,
            { 'Retry-After': String(retryAfter) },
        );
    }

    const parsed = await readBody(request);
    if (parsed.error) return parsed.error;
    const { email, researchId } = parsed;
    const now = Math.floor(Date.now() / 1000);

    let plan;
    let applied;
    try {
        const rows = await readRowsForEmail(env.DB, email);
        plan = decideSubscribeAction(rows, { researchId, now });
        applied = await applyAction(env.DB, plan, rows, { email, researchId, now });
    } catch (err) {
        console.error('Subscribe insert failed:', err instanceof Error ? err.message : String(err));
        return jsonResponse({ ok: false, error: 'server_error', message: 'Something went wrong on our end. Please try again shortly.' }, 500);
    }

    if (plan.sendConfirmation && applied.rowId != null && applied.confirmToken) {
        // Best effort: a mail failure never changes the response, because the
        // response must not reveal which state this address is in. The send is
        // awaited, so the SMTP dialogue can never outlive the request context.
        const outcome = await sendConfirmation(env, { email, researchId, now, ...applied })
            .catch((err) => ({ ok: false, error: err instanceof Error ? err.message : String(err) }));
        if (!outcome?.ok) logUndeliveredConfirmation(outcome || {}, applied.rowId);
    }

    return jsonResponse(mailConfigured(env) ? { ok: true } : { ok: true, mail: 'off' });
}
