#!/usr/bin/env node
// One-time(ish) backfill: find product photos for every product missing an
// image_url. Serper Images query per product (same ranking as the worker's
// image-resolver — shared import), server-side verification that the URL
// actually serves a real image, then writes via the Cloudflare D1 HTTP API.
//
//   node scripts/backfill-images.mjs            # full run
//   node scripts/backfill-images.mjs --limit 20 # trial batch
//
// Needs CLOUDFLARE_API_TOKEN in the environment and .dev.vars (SERPER_API_KEY):
//   bws-exec FRANK_CLOUDFLARE_API_TOKEN -- sh -c \
//     'CLOUDFLARE_API_TOKEN="$FRANK_CLOUDFLARE_API_TOKEN" node scripts/backfill-images.mjs'
// Cost: 1 Serper credit per missing product (~750 ≈ well under $1).

import { readFileSync } from 'node:fs';
import { pickBestImage, buildImageQuery } from '../worker/lib/image-resolver.js';

const ACCOUNT_ID = '06c8d26cd83f87b95cd1d5467cb712a2';
const DB_ID = 'd02b3826-a46a-4821-8f3a-6e3a80407155';

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

// Image servers sometimes kill HTTP/2 sockets in ways undici surfaces as
// async 'error' events outside any await — without these guards one rude
// CDN aborts the whole run.
process.on('uncaughtException', (e) => console.error('uncaught:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e?.message || e));

const cfToken = process.env.CLOUDFLARE_API_TOKEN;
const serperKey = readEnvFile('.dev.vars').SERPER_API_KEY || process.env.SERPER_API_KEY;
if (!cfToken) {
  console.error('need CLOUDFLARE_API_TOKEN in the environment: run under bws-exec with BWS key FRANK_CLOUDFLARE_API_TOKEN (see the header)');
  process.exit(1);
}
if (!serperKey) {
  console.error('need SERPER_API_KEY (.dev.vars)');
  process.exit(1);
}

const limitArg = process.argv.indexOf('--limit');
const LIMIT = limitArg > -1 ? parseInt(process.argv[limitArg + 1], 10) : 10000;

async function d1(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/d1/database/${DB_ID}/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!body.success) throw new Error(`D1: ${JSON.stringify(body.errors)}`);
  return body.result[0]?.results ?? [];
}

async function serperImages(q) {
  const res = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': serperKey },
    body: JSON.stringify({ q, num: 10 }),
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  return (await res.json()).images ?? [];
}

// A picked URL only counts if it really serves an image of plausible size.
async function verifiesAsImage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8',
      },
    });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return false;
    const buf = await res.arrayBuffer();
    return buf.byteLength >= 3000;
  } catch {
    return false;
  }
}

const REVERIFY = process.argv.includes('--reverify');

let rows;
if (REVERIFY) {
  // Re-check products that already have an image: rotted/dead URLs get
  // blanked and refilled through the same search+verify flow below.
  const withImages = await d1(
    `SELECT p.id, p.name, p.brand, p.image_url FROM products p
     JOIN research r ON r.id = p.research_id
     WHERE p.image_url LIKE 'https://%' AND r.status = 'complete'
     ORDER BY r.view_count DESC LIMIT ?1`, [LIMIT],
  );
  console.log(`${withImages.length} existing images to re-verify`);
  rows = [];
  for (const p of withImages) {
    if (await verifiesAsImage(p.image_url)) continue;
    console.log(`  rotted: ${p.name} (${p.image_url.slice(0, 60)})`);
    rows.push(p);
  }
  console.log(`${rows.length} rotted images to refill`);
} else {
  rows = await d1(
    `SELECT p.id, p.name, p.brand FROM products p
     JOIN research r ON r.id = p.research_id
     WHERE (p.image_url IS NULL OR p.image_url = '') AND r.status = 'complete'
     ORDER BY r.view_count DESC LIMIT ?1`, [LIMIT],
  );
  console.log(`${rows.length} products missing images`);
}

let found = 0, verifiedFail = 0, noResult = 0, errors = 0;
let i = 0;
for (const p of rows) {
  i++;
  const query = buildImageQuery({ name: p.name, brand: p.brand });
  if (!query) { noResult++; continue; }
  try {
    const images = await serperImages(query);
    // Try the ranked candidates in order until one verifies (max 3 fetches).
    let chosen = '';
    const ranked = [];
    let pool = images;
    for (let k = 0; k < 3 && pool.length > 0; k++) {
      const pick = pickBestImage(pool);
      if (!pick) break;
      ranked.push(pick);
      pool = pool.filter((im) => {
        let u = (im?.imageUrl || '').replace(/^http:\/\//, 'https://');
        return u !== pick;
      });
    }
    for (const cand of ranked) {
      if (await verifiesAsImage(cand)) { chosen = cand; break; }
    }
    if (chosen) {
      await d1('UPDATE products SET image_url = ?1 WHERE id = ?2', [chosen, p.id]);
      found++;
    } else if (ranked.length > 0) {
      verifiedFail++;
    } else {
      noResult++;
    }
  } catch (err) {
    errors++;
    console.error(`  error on "${p.name}": ${err.message}`);
    if (errors > 25) { console.error('too many errors — aborting'); break; }
  }
  if (i % 25 === 0) console.log(`progress ${i}/${rows.length}: found=${found} verify-fail=${verifiedFail} no-result=${noResult} errors=${errors}`);
}

console.log(`DONE: found=${found} verify-fail=${verifiedFail} no-result=${noResult} errors=${errors} of ${rows.length}`);
