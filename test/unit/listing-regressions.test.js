// Regression tests for four listing and form defects (CP-342, CP-343,
// CP-344, CP-357). The SQL cases run the real queries against an in-memory
// SQLite database (node:sqlite) through a small D1-shaped adapter, so the
// assertions check behavior, not query text.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { getLatestResearchLastmod } from '../../worker/lib/sitemap.js';
import { recentVerdictsSection } from '../../worker/pages/home.js';
import { renderVerifyEntryPage } from '../../worker/pages/verify-page.js';
import { subscribeScript } from '../../worker/pages/research-scripts.js';
import { handleStartVerify } from '../../worker/handlers/verify.js';

const SCHEMA = `
CREATE TABLE research (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, query TEXT NOT NULL,
  status TEXT NOT NULL, kind TEXT, category TEXT, facets TEXT, result TEXT,
  created_at INTEGER NOT NULL, completed_at INTEGER, retired_at INTEGER
);
CREATE TABLE products (id TEXT PRIMARY KEY, research_id TEXT NOT NULL);`;

const PUBLIC_PRODUCT_COUNT = 3;
const CACHE_VERSION = 'test';
const VERIFIED_CLAIMS = JSON.stringify({
  claims: Array.from({ length: 4 }, () => ({ status: 'verified', claimType: 'spec' })),
});

// D1-shaped wrapper: prepare(sql).bind(...).first() / .all().
function d1(db) {
  return {
    prepare(sql) {
      const make = (args) => ({
        bind: (...next) => make(next),
        first: async () => db.prepare(sql).get(...args) ?? null,
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        run: async () => db.prepare(sql).run(...args),
      });
      return make([]);
    },
  };
}

// KV that never holds a value, so every call reaches the database.
const EMPTY_KV = Object.freeze({ get: async () => null, put: async () => {} });

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  return db;
}

function insertReport(db, { id, query, completedAt, retiredAt = null }) {
  db.prepare(`INSERT INTO research (id, slug, query, status, created_at, completed_at, retired_at)
    VALUES (?1, ?2, ?3, 'complete', ?4, ?4, ?5)`).run(id, `slug-${id}`, query, completedAt, retiredAt);
  for (let i = 0; i < PUBLIC_PRODUCT_COUNT; i++) {
    db.prepare('INSERT INTO products (id, research_id) VALUES (?1, ?2)').run(`${id}-p${i}`, id);
  }
}

function insertVerification(db, { id, query, completedAt }) {
  db.prepare(`INSERT INTO research (id, slug, query, status, kind, result, created_at, completed_at)
    VALUES (?1, ?2, ?3, 'complete', 'verification', ?4, ?5, ?5)`)
    .run(id, `verify-${id}`, query, VERIFIED_CLAIMS, completedAt);
}

const lastmodFor = (db) => getLatestResearchLastmod({ DB: d1(db), KV: EMPTY_KV }, CACHE_VERSION);

// CP-342: retiring a report must move the lastmod forward, or conditional
// GETs keep answering 304 with the retired URL still listed.
async function lastmodCases(eq) {
  const seed = () => {
    const db = freshDb();
    insertReport(db, { id: 'a', query: 'best robot vacuum cleaner', completedAt: 1000 });
    insertReport(db, { id: 'b', query: 'best espresso machine home', completedAt: 2000 });
    insertReport(db, { id: 'c', query: 'best noise cancelling headphones', completedAt: 3000 });
    return db;
  };

  eq('lastmod: no retired rows gives the newest completed_at', await lastmodFor(seed()), 3000);

  const olderRetired = seed();
  olderRetired.prepare('UPDATE research SET retired_at = 5000 WHERE id = ?1').run('a');
  eq('lastmod: retiring an older report moves lastmod to the retire time',
    await lastmodFor(olderRetired), 5000);

  const newestRetired = seed();
  newestRetired.prepare('UPDATE research SET retired_at = 5000 WHERE id = ?1').run('c');
  const lm = await lastmodFor(newestRetired);
  eq('lastmod: retiring the newest report never moves lastmod backward', lm >= 3000, true);
  eq('lastmod: retiring the newest report moves lastmod to the retire time', lm, 5000);
}

// CP-344: the homepage verdict strip must apply the junk-query rules the
// other listings use (no "test ..." names, no short single-token names).
async function verdictCases(eq) {
  const db = freshDb();
  const good = ['Sony WH-1000XM5 headphones', 'Dyson V15 Detect vacuum', 'Breville Barista Express'];
  good.forEach((query, i) => insertVerification(db, { id: `g${i}`, query, completedAt: 1000 + i }));
  insertVerification(db, { id: 'junk1', query: 'test product please ignore', completedAt: 5000 });
  insertVerification(db, { id: 'junk2', query: 'asdf', completedAt: 5001 });

  const html = await recentVerdictsSection({ DB: d1(db) });
  eq('verdicts: section still renders for good rows', html.includes('id="recent-verdicts"'), true);
  good.forEach((query, i) => eq(`verdicts: shows "${query}"`, html.includes(`/verify/verify-g${i}"`), true));
  eq('verdicts: hides a "test ..." product name', html.includes('/verify/verify-junk1"'), false);
  eq('verdicts: hides a short single-token junk name', html.includes('/verify/verify-junk2"'), false);
}

// CP-343: with JavaScript off, the entry form must post to the verify intake
// route, and that route must accept a normal form body.
async function verifyFormCases(eq) {
  const html = renderVerifyEntryPage('');
  const formTag = html.match(/<form[^>]*id="verify-form"[^>]*>/)?.[0] ?? '';
  eq('verify form: action is the intake route', /\saction="\/api\/verify"/.test(formTag), true);
  eq('verify form: method is POST', /\smethod="post"/i.test(formTag), true);

  const request = new Request('https://frank.test/api/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://frank.test' },
    body: new URLSearchParams({ product: 'ab' }).toString(),
  });
  const res = await handleStartVerify(request, {});
  const body = await res.json();
  eq('verify intake: a form body is read (too-short product hits the length rule)',
    /at least/.test(body.error ?? ''), true);
}

// CP-357: while mail is off, the signup copy must not promise an email.
function subscribeCopyCases(eq) {
  const promisesMail = (js) => /inbox|click the link/i.test(js);
  eq('subscribe copy: mail on still asks the visitor to check the inbox',
    promisesMail(subscribeScript('r1', { mailEnabled: true })), true);
  eq('subscribe copy: mail off does not mention an inbox',
    promisesMail(subscribeScript('r1', { mailEnabled: false })), false);
  eq('subscribe copy: no mail flag is treated as mail off (fail closed)',
    promisesMail(subscribeScript('r1')), false);
}

export async function runListingRegressionTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  await lastmodCases(eq);
  await verdictCases(eq);
  await verifyFormCases(eq);
  subscribeCopyCases(eq);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runListingRegressionTests();
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.log(`listing-regressions: ${report.passed}/${report.passed + report.failed} passed`);
  process.exit(report.failed > 0 ? 1 : 0);
}
