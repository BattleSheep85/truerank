/**
 * Authentication primitives — zero dependencies, WebCrypto only.
 *
 * Passwords: PBKDF2-SHA256, 600k iterations (OWASP 2023 guidance), 16-byte
 * random salt, stored as `pbkdf2$<iterations>$<salt-b64>$<hash-b64>`. verifyPassword
 * reads the iteration count FROM the stored hash, so raising this constant only
 * affects new hashes — existing lower-cost hashes keep verifying.
 *
 * Sessions: 32 random bytes → base64url cookie token. D1 stores only the
 * SHA-256 hex of the token (a leaked sessions table can't be replayed).
 */

import { generateId } from './db.js';
import { nowEpoch } from './utils.js';

const PBKDF2_ITERATIONS = 600_000;
const SESSION_COOKIE = 'tr_sess';
const SESSION_TTL_SECONDS = 30 * 86400; // 30 days

function b64encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function b64decode(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function b64url(bytes) {
    return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveBits(password, salt, iterations) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
    );
    return crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256,
    );
}

export async function hashPassword(password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const bits = new Uint8Array(await deriveBits(password, salt, PBKDF2_ITERATIONS));
    return `pbkdf2$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password, stored) {
    try {
        const [scheme, iterStr, saltB64, hashB64] = String(stored || '').split('$');
        if (scheme !== 'pbkdf2') return false;
        const iterations = parseInt(iterStr, 10);
        if (!Number.isFinite(iterations) || iterations < 1000) return false;
        const expected = b64decode(hashB64);
        const actual = new Uint8Array(await deriveBits(password, b64decode(saltB64), iterations));
        if (expected.length !== actual.length) return false;
        // Constant-time compare — never early-exit on the first mismatched byte.
        let diff = 0;
        for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
        return diff === 0;
    } catch {
        return false;
    }
}

async function sha256Hex(input) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// --- Sessions ---------------------------------------------------------------

/**
 * Create a session row for a user. Returns { token, cookie } — the raw token
 * goes in the Set-Cookie header; only its hash is persisted.
 */
export async function createSession(db, userId) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const token = b64url(raw);
    const tokenHash = await sha256Hex(token);
    const now = nowEpoch();
    await db.prepare(
        'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(tokenHash, userId, now, now + SESSION_TTL_SECONDS).run();
    return { token, cookie: sessionCookie(token, SESSION_TTL_SECONDS) };
}

export function sessionCookie(token, maxAge) {
    return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie() {
    return sessionCookie('', 0);
}

function readSessionToken(request) {
    const cookie = request.headers.get('Cookie') || '';
    const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([A-Za-z0-9_-]{20,64})`));
    return m ? m[1] : null;
}

/**
 * Resolve the logged-in user from the request cookie, or null. Expired
 * sessions are treated as absent (a periodic delete keeps the table tidy).
 */
export async function getSessionUser(request, env) {
    const token = readSessionToken(request);
    if (!token) return null;
    try {
        const tokenHash = await sha256Hex(token);
        const row = await env.DB.prepare(
            `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.email
             FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2`
        ).bind(tokenHash, nowEpoch()).first();
        if (!row) return null;
        return { id: row.user_id, email: row.email, tokenHash: row.token_hash };
    } catch (err) {
        console.error('[auth] session lookup failed:', err instanceof Error ? err.message : String(err));
        return null;
    }
}

export async function destroySession(db, tokenHash) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
}

/**
 * Delete session rows whose expires_at has passed.
 * Returns the number of rows deleted.
 */
export async function purgeExpiredSessions(db, now) {
    const cutoff = typeof now === 'number'
        ? (now > 1e11 ? Math.floor(now / 1000) : now)
        : nowEpoch();
    const result = await db.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(cutoff).run();
    return result.meta?.changes ?? 0;
}

// --- Users -------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validEmail(email) {
    return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

export function validPassword(password) {
    return typeof password === 'string' && password.length >= 8 && password.length <= 200;
}

export async function createUser(db, email, password) {
    const id = generateId();
    const passwordHash = await hashPassword(password);
    await db.prepare(
        'INSERT INTO users (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)'
    ).bind(id, email.toLowerCase(), passwordHash, nowEpoch()).run();
    return id;
}

export async function findUserByEmail(db, email) {
    return db.prepare('SELECT * FROM users WHERE email = ?1').bind(String(email || '').toLowerCase()).first();
}

/**
 * Delete a user and all their associated data (search history, sessions, user record).
 */
export async function deleteUser(db, userId) {
    await db.batch([
        db.prepare('DELETE FROM user_searches WHERE user_id = ?1').bind(userId),
        db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId),
        db.prepare('DELETE FROM users WHERE id = ?1').bind(userId),
    ]);
}

// --- Search history ----------------------------------------------------------

/**
 * Record (or refresh) a user's search → research association. Best-effort:
 * history must never break research submission.
 */
export async function recordUserSearch(db, userId, researchId, query) {
    try {
        await db.prepare(
            `INSERT INTO user_searches (user_id, research_id, query, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id, research_id) DO UPDATE SET created_at = excluded.created_at`
        ).bind(userId, researchId, query, nowEpoch()).run();
    } catch (err) {
        console.error('[auth] recordUserSearch failed:', err instanceof Error ? err.message : String(err));
    }
}

export async function getUserSearches(db, userId, limit = 50) {
    const rows = await db.prepare(
        `SELECT us.query, us.created_at, r.slug, r.status, r.category
         FROM user_searches us
         LEFT JOIN research r ON r.id = us.research_id
         WHERE us.user_id = ?1
           AND r.retired_at IS NULL
         ORDER BY us.created_at DESC
         LIMIT ?2`
    ).bind(userId, limit).all();
    return rows.results ?? [];
}
