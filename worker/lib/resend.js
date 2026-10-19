/**
 * Resend transport: one `POST https://api.resend.com/emails` over `fetch`.
 *
 * Replaced the hand-written SMTP client on 2026-10-19 (CP-622). A deployed
 * Worker cannot open a socket to Hostinger's SMTP hosts (they sit on
 * Cloudflare's own network), so mail now goes through Resend's HTTP API.
 * Provider comparison: docs/email-design.md section 3.
 *
 * `buildResendPayload` is pure. It checks both addresses and throws on any CR
 * or LF in a header, so a query string can never inject a Bcc line.
 *
 * SECURITY: the API key goes only into the Authorization header. Errors carry
 * the HTTP status and Resend's reason, with the key redacted, never the body.
 */

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 15_000;
const HTTP_TOO_MANY = 429;
// One retry after a 429, waiting what Retry-After asks, within these bounds.
const RETRY_DEFAULT_MS = 1_000;
const RETRY_MAX_MS = 2_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LEN = 254;
const REASON_MAX_CHARS = 200;
// A display name made of these characters needs no quoting (RFC 5322 atext + space).
const PLAIN_NAME_RE = /^[A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]*$/;

export class ResendError extends Error {
    constructor(message, status = 0) {
        super(message);
        this.name = 'ResendError';
        this.status = status;
    }
}

/** True when the address passes the intake check and the length limit. */
export function isValidEmailAddress(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= EMAIL_MAX_LEN && EMAIL_RE.test(value);
}

/** Throw when a header value carries a CR or LF (header injection guard). */
function assertNoCrlf(name, value) {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) throw new Error(`Header ${name} contains a line break.`);
    return text;
}

/** `Name <addr>`, quoting the name when it holds special characters. */
function formatAddress(address, name) {
    const clean = assertNoCrlf('From name', name).trim();
    if (!clean) return address;
    const shown = PLAIN_NAME_RE.test(clean) ? clean : `"${clean.replace(/["\\]/g, '\\$&')}"`;
    return `${shown} <${address}>`;
}

/**
 * Build the JSON body for the Resend send API.
 *
 * @param {{from: string, fromName?: string, to: string, subject: string,
 *          text: string, html: string, extraHeaders?: Record<string,string>}} input
 * @returns {{from: string, to: string[], subject: string, text: string,
 *            html: string, headers: Record<string,string>}}
 */
export function buildResendPayload(input) {
    const { from, fromName = '', to, subject, text, html, extraHeaders = {} } = input;
    if (!isValidEmailAddress(from)) throw new Error('From address is not valid.');
    if (!isValidEmailAddress(to)) throw new Error('To address is not valid.');
    const extra = Object.fromEntries(Object.entries(extraHeaders).map(([name, value]) => [
        assertNoCrlf('header name', name),
        assertNoCrlf(name, value),
    ]));
    return {
        from: formatAddress(from, fromName),
        to: [to],
        subject: assertNoCrlf('Subject', subject),
        text: String(text ?? ''),
        html: String(html ?? ''),
        headers: { 'Auto-Submitted': 'auto-generated', ...extra },
    };
}

/** Resend's own reason for a refusal, trimmed, with the key removed. */
async function refusalReason(res, apiKey) {
    let reason = '';
    try {
        const body = await res.json();
        reason = typeof body?.message === 'string' ? body.message : '';
    } catch {
        reason = '';
    }
    const safe = reason.split(apiKey).join('[key]').slice(0, REASON_MAX_CHARS);
    return safe ? `Resend refused the message (HTTP ${res.status}): ${safe}` : `Resend refused the message (HTTP ${res.status}).`;
}

/** The message id from a 2xx answer, or '' when the body is not JSON. */
async function messageId(res) {
    try {
        const body = await res.json();
        return typeof body?.id === 'string' ? body.id : '';
    } catch {
        return '';
    }
}

/** Milliseconds to wait before retrying a 429, from its Retry-After header. */
export function retryDelayMs(res) {
    const seconds = Number(res.headers.get('retry-after'));
    if (!Number.isFinite(seconds) || seconds <= 0) return RETRY_DEFAULT_MS;
    return Math.min(seconds * 1000, RETRY_MAX_MS);
}

/** One POST. Network failures and timeouts become a ResendError. */
async function postOnce(apiKey, payload, timeoutMs, fetchImpl) {
    try {
        return await fetchImpl(RESEND_ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
        const reason = timedOut ? `timed out after ${timeoutMs} ms` : String(err?.message || err);
        throw new ResendError(`Resend request failed: ${reason.split(apiKey).join('[key]')}`);
    }
}

/**
 * Send one payload. A 429 (rate limit) is retried once. Throws ResendError on a refusal, a timeout, or a network
 * failure. The caller (mailer.js) catches everything.
 *
 * @param {{apiKey: string, timeoutMs?: number}} cfg
 * @param {object} payload from buildResendPayload
 * @param {typeof fetch} [fetchImpl] injected in unit tests
 * @param {(ms: number) => Promise<void>} [sleep] injected in unit tests
 * @returns {Promise<{ok: true, response: string}>} response = Resend message id
 */
export async function sendViaResend(cfg, payload, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
    const apiKey = cfg?.apiKey || '';
    if (!apiKey) throw new ResendError('No Resend API key.');
    const timeoutMs = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
    let res = await postOnce(apiKey, payload, timeoutMs, fetchImpl);
    if (res.status === HTTP_TOO_MANY) {
        await sleep(retryDelayMs(res));
        res = await postOnce(apiKey, payload, timeoutMs, fetchImpl);
    }
    if (!res.ok) throw new ResendError(await refusalReason(res, apiKey), res.status);
    return { ok: true, response: await messageId(res) };
}
