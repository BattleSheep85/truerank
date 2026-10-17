#!/usr/bin/env node
// One-time(ish) backfill: find product photos for every product missing an
// image_url. One image query per product through the worker's image-resolver
// chain (shared import, CP-715): SearXNG images when SEARXNG_URL is set, with
// Brave as a per-query backup when BRAVE_API_KEY is set (Serper first only
// when SERPER_API_KEY is set). Same ranking as the worker, server-side
// verification that the URL actually serves a real image, then writes via the
// Cloudflare D1 HTTP API.
//
//   node scripts/backfill-images.mjs            # full run
//   node scripts/backfill-images.mjs --limit 20 # trial batch
//
// Needs .cf-token (CLOUDFLARE_API_TOKEN) and, in .dev.vars or the environment,
// SEARXNG_URL plus LITELLM_GATE_TOKEN (BWS LITELLM_EDGE_GATE). SearXNG is free.

import { readFileSync } from 'node:fs';
import { buildImageQuery, imageCandidateSearch, rankImages } from '../worker/lib/image-resolver.js';

const ACCOUNT_ID = '06c8d26cd83f87b95cd1d5467cb712a2';
const DB_ID = 'd02b3826-a46a-4821-8f3a-6e3a80407155';
const SEARCH_KEYS = ['SERPER_API_KEY', 'SEARXNG_URL', 'LITELLM_GATE_TOKEN', 'BRAVE_API_KEY'];
const VERIFY_TIMEOUT_MS = 10000;
const MIN_IMAGE_BYTES = 3000;
const MAX_ERRORS = 25;
const PROGRESS_EVERY = 25;
const DEFAULT_LIMIT = 10000;

function readEnvFile(path) {
  const out = {};
  try {
    for (const line of readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* missing file → empty */ }
  return out;
}

/** The image search settings: a .dev.vars value first, else the environment. */
export function backfillEnv(fileVars, procEnv) {
  return Object.freeze(Object.fromEntries(SEARCH_KEYS.map((k) => [k, fileVars?.[k] || procEnv?.[k] || undefined])));
}

/**
 * Search once, then check the ranked candidates in order (at most three)
 * until one really serves an image. Returns { chosen, ranked }; chosen is ''
 * when none passes.
 */
export async function pickVerifiedImage(search, query, verify) {
  const ranked = rankImages(await search(query));
  for (const cand of ranked) {
    if (await verify(cand)) return { chosen: cand, ranked };
  }
  return { chosen: '', ranked };
}

// A picked URL only counts if it really serves an image of plausible size.
async function verifiesAsImage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength >= MIN_IMAGE_BYTES;
  } catch {
    return false;
  }
}

function makeD1(cfToken) {
  return async function d1(sql, params = []) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql, params }),
    });
    const body = await res.json();
    if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors)}`);
    return body.result[0]?.results ?? [];
  };
}

// Re-check products that already have an image: rotted/dead URLs get
// refilled through the same search+verify flow as missing ones.
async function rottedRows(d1, limit) {
  const withImages = await d1(
    `SELECT p.id, p.name, p.brand, p.image_url FROM products p
     JOIN research r ON r.id = p.research_id
     WHERE p.image_url LIKE 'https://%' AND r.status = 'complete'
     ORDER BY r.view_count DESC LIMIT ?1`, [limit],
  );
  console.log(`${withImages.length} existing images to re-verify`);
  const rows = [];
  for (const p of withImages) {
    if (await verifiesAsImage(p.image_url)) continue;
    console.log(`  rotted: ${p.name} (${p.image_url.slice(0, 60)})`);
    rows.push(p);
  }
  console.log(`${rows.length} rotted images to refill`);
  return rows;
}

async function missingRows(d1, limit) {
  const rows = await d1(
    `SELECT p.id, p.name, p.brand FROM products p
     JOIN research r ON r.id = p.research_id
     WHERE (p.image_url IS NULL OR p.image_url = '') AND r.status = 'complete'
     ORDER BY r.view_count DESC LIMIT ?1`, [limit],
  );
  console.log(`${rows.length} products missing images`);
  return rows;
}

// One product: 'found', 'verify-fail' or 'no-result'. Throws on a D1 error.
async function fillOne(p, search, d1) {
  const query = buildImageQuery({ name: p.name, brand: p.brand });
  if (!query) return 'no-result';
  const { chosen, ranked } = await pickVerifiedImage(search, query, verifiesAsImage);
  if (chosen) {
    await d1('UPDATE products SET image_url = ?1 WHERE id = ?2', [chosen, p.id]);
    return 'found';
  }
  return ranked.length > 0 ? 'verify-fail' : 'no-result';
}

function countsLine(c) {
  return `found=${c.found} verify-fail=${c['verify-fail']} no-result=${c['no-result']} errors=${c.errors}`;
}

async function fillImages(rows, search, d1) {
  let counts = { found: 0, 'verify-fail': 0, 'no-result': 0, errors: 0 };
  for (const [i, p] of rows.entries()) {
    try {
      const outcome = await fillOne(p, search, d1);
      counts = { ...counts, [outcome]: counts[outcome] + 1 };
    } catch (err) {
      counts = { ...counts, errors: counts.errors + 1 };
      console.error(`  error on "${p.name}": ${err.message}`);
      if (counts.errors > MAX_ERRORS) { console.error('too many errors — aborting'); break; }
    }
    if ((i + 1) % PROGRESS_EVERY === 0) console.log(`progress ${i + 1}/${rows.length}: ${countsLine(counts)}`);
  }
  console.log(`DONE: ${countsLine(counts)} of ${rows.length}`);
}

async function main() {
  // Image servers sometimes kill HTTP/2 sockets in ways undici surfaces as
  // async 'error' events outside any await — without these guards one rude
  // CDN aborts the whole run.
  process.on('uncaughtException', (e) => console.error('uncaught:', e?.message || e));
  process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message || e));

  const cfToken = readEnvFile('.cf-token').CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const search = imageCandidateSearch(backfillEnv(readEnvFile('.dev.vars'), process.env));
  if (!cfToken || !search) {
    console.error('need CLOUDFLARE_API_TOKEN (.cf-token) and SEARXNG_URL + LITELLM_GATE_TOKEN (.dev.vars or env; BRAVE_API_KEY or SERPER_API_KEY also work)');
    process.exit(1);
  }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : DEFAULT_LIMIT;
  const d1 = makeD1(cfToken);
  const rows = process.argv.includes('--reverify') ? await rottedRows(d1, limit) : await missingRows(d1, limit);
  await fillImages(rows, search, d1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
