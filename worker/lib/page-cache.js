// Saved evidence pages for /verify (CP-789).
//
// Two runs of one product gathered different pages, so the judges saw
// different evidence and the scores swung (Fractal Design North 70 vs 50).
// The owner approved (2026-10-23) keeping the pages a check judged for 30
// days: the first run saves its claims and its scored evidence in KV under
// the product's key, and a later run of the same product inside 30 days
// judges the same pages. The cost: a re-check does not see new reviews until
// the entry expires. KV, not D1: one read per check, a native TTL, and the
// claim sets (claim-cache.js) already live there with the same key rules.

import { productCacheSubject, validClaim, CLAIM_CACHE_VERSION } from './claim-cache.js';

/** Bump when the saved shape or the evidence scoring changes. */
export const PAGE_CACHE_VERSION = 'v1';
/** Same window as the saved claims and the saved-verdict reuse. */
export const PAGE_CACHE_TTL_SECONDS = 30 * 86400;
/** A check that ended with no score keeps its pages this long (as claim-cache.js). */
export const PAGE_CACHE_WEAK_TTL_SECONDS = 86400;
/** KV takes 25 MiB per value; a normal check saves about 1 MB. */
export const PAGE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const KEY_PREFIX = `verify-pages:${PAGE_CACHE_VERSION}:`;
const LOG = '[page-cache]';

/** The KV key of a product's saved pages, or null (same rules as claimCacheKey). */
export function pageCacheKey(product, productUrl = null) {
  const subject = productCacheSubject(product, productUrl);
  return subject ? KEY_PREFIX + subject : null;
}

function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}

function isWebUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

function validSource(s) {
  return Boolean(s) && isWebUrl(s.url)
    && (s.title == null || typeof s.title === 'string')
    && typeof s.content === 'string'
    && Number.isFinite(s.credibility) && Number.isFinite(s.independence)
    && Array.isArray(s.tags) && s.tags.every((t) => typeof t === 'string');
}

// Only the fields judgeClaims reads leave or enter the cache.
function judgeFields(s) {
  return { url: s.url, title: s.title ?? '', content: s.content, credibility: s.credibility, independence: s.independence, tags: [...s.tags] };
}

// Why a parsed entry cannot be used, or '' when it is good.
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'not an object';
  if (entry.version !== PAGE_CACHE_VERSION) return `version ${entry.version}`;
  if (entry.claimVersion !== CLAIM_CACHE_VERSION) return `claim version ${entry.claimVersion}`;
  if (!Number.isFinite(entry.savedAt)) return 'no saved time';
  if (!Array.isArray(entry.sources) || entry.sources.length === 0) return 'no sources';
  if (entry.count !== entry.sources.length) return `partial (${entry.sources.length} of ${entry.count} sources)`;
  if (!entry.sources.every(validSource)) return 'a bad source';
  if (!Array.isArray(entry.claims) || entry.claims.length === 0 || !entry.claims.every(validClaim)) return 'bad claims';
  if (!Array.isArray(entry.claimSourceUrls) || !entry.claimSourceUrls.every((u) => typeof u === 'string')) return 'bad claim page urls';
  return '';
}

/**
 * The saved pages of `product` (and its pasted page `productUrl`), as
 * { claims, claimSourceUrls, sources, savedAt }, or null when there is no KV,
 * no key, nothing saved, or the entry is expired, bad, or partial (logged).
 * Claims are renumbered c1..cN. `opts.now` (ms) is for tests. Never throws.
 */
export async function readSavedPages(kv, product, productUrl = null, { now = Date.now() } = {}) {
  const key = pageCacheKey(product, productUrl);
  if (!kv || !key) return null;
  let raw;
  try {
    raw = await kv.get(key);
  } catch (err) {
    console.error(`${LOG} read failed for ${key}: ${errorText(err)}`);
    return null;
  }
  if (!raw) return null;
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch (err) {
    console.warn(`${LOG} ignored ${key}: invalid JSON (${errorText(err)})`);
    return null;
  }
  const problem = entryProblem(entry);
  if (problem) {
    console.warn(`${LOG} ignored ${key}: ${problem}`);
    return null;
  }
  if (now - entry.savedAt > PAGE_CACHE_TTL_SECONDS * 1000) {
    console.warn(`${LOG} ignored ${key}: expired (saved ${new Date(entry.savedAt).toISOString()})`);
    return null;
  }
  return {
    claims: entry.claims.map((c, i) => ({ id: `c${i + 1}`, text: c.text.trim(), type: c.type })),
    claimSourceUrls: [...entry.claimSourceUrls],
    sources: entry.sources.map(judgeFields),
    savedAt: entry.savedAt,
  };
}

/**
 * Saves the claims, claim page urls, and scored evidence (`saved.sources`,
 * scoreEvidence's shape) of a check for PAGE_CACHE_TTL_SECONDS. Returns true
 * when saved; false with nothing to save, no KV or key, over
 * PAGE_CACHE_MAX_BYTES, or a KV error (logged). Never throws.
 */
export async function writeSavedPages(kv, product, productUrl, saved, { now = Date.now() } = {}) {
  const key = pageCacheKey(product, productUrl);
  const sources = (saved?.sources ?? []).filter(validSource).map(judgeFields);
  const claims = (saved?.claims ?? []).filter(validClaim).map(({ text, type }) => ({ text, type }));
  if (!kv || !key || sources.length === 0 || claims.length === 0) return false;
  const claimSourceUrls = (saved?.claimSources ?? []).map((s) => s?.url).filter((u) => typeof u === 'string');
  const entry = { version: PAGE_CACHE_VERSION, claimVersion: CLAIM_CACHE_VERSION, savedAt: now, count: sources.length, claims, claimSourceUrls, sources };
  const json = JSON.stringify(entry);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > PAGE_CACHE_MAX_BYTES) {
    console.warn(`${LOG} not saved ${key}: too big (${bytes} bytes, cap ${PAGE_CACHE_MAX_BYTES})`);
    return false;
  }
  try {
    await kv.put(key, json, { expirationTtl: PAGE_CACHE_TTL_SECONDS });
    return true;
  } catch (err) {
    console.error(`${LOG} write failed for ${key}: ${errorText(err)}`);
    return false;
  }
}

/**
 * Keeps the saved pages of `product` only PAGE_CACHE_WEAK_TTL_SECONDS from
 * now and marks them `short`, after a check with no score, so a later run
 * gathers again. An entry already marked keeps its first expiry. Returns true
 * when shortened now. A KV error or bad entry is logged and gives false.
 */
export async function shortenSavedPages(kv, product, productUrl = null) {
  const key = pageCacheKey(product, productUrl);
  if (!kv || !key) return false;
  try {
    const raw = await kv.get(key);
    if (!raw) return false;
    const entry = JSON.parse(raw);
    if (entry?.short === true) return false;
    await kv.put(key, JSON.stringify({ ...entry, short: true }), { expirationTtl: PAGE_CACHE_WEAK_TTL_SECONDS });
    return true;
  } catch (err) {
    console.error(`${LOG} shorten failed for ${key}: ${errorText(err)}`);
    return false;
  }
}
