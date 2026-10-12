// Regression tests for CP-340: a retired report (research.retired_at set) must
// not be served at /research/<slug>/og.svg, GET /api/report/<id>, or POST
// /api/chat, and must not appear in a user's search history. Each surface must
// answer a retired report exactly as it answers a missing one. The SQL runs
// against an in-memory SQLite database (node:sqlite) through a D1-shaped adapter.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { generateOgImage } from '../../worker/lib/sitemap.js';
import { handleGetReport } from '../../worker/handlers/report.js';
import { handleChat } from '../../worker/handlers/chat.js';
import { getUserSearches } from '../../worker/lib/auth.js';

const SCHEMA = `
CREATE TABLE research (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, query TEXT NOT NULL,
  status TEXT NOT NULL, kind TEXT, category TEXT, summary TEXT, facets TEXT,
  result TEXT, sources TEXT, clarifications TEXT, cost_usd REAL,
  created_at INTEGER NOT NULL, completed_at INTEGER, retired_at INTEGER
);
CREATE TABLE products (
  id TEXT PRIMARY KEY, research_id TEXT NOT NULL, name TEXT, rank INTEGER,
  pros TEXT, cons TEXT
);
CREATE TABLE user_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL,
  research_id TEXT NOT NULL, query TEXT NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(user_id, research_id)
);`;

const USER_ID = 'user-1';
const RETIRED_AT = 1_800_000_500;
const LIVE = Object.freeze({ id: 'live-1', slug: 'best-robot-vacuum-live1', query: 'best robot vacuum cleaner' });
const RETIRED = Object.freeze({ id: 'gone-1', slug: 'best-espresso-machine-gone1', query: 'best espresso machine home' });
const MISSING = Object.freeze({ id: 'nope-1', slug: 'no-such-report-nope1' });
const REPORT_RESULT = JSON.stringify({ summary: 'A summary.', source_count: 4, filtered_count: 1 });

// D1-shaped wrapper: prepare(sql).bind(...).first() / .all() / .run().
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

const memoryKv = () => {
  const store = new Map();
  return {
    get: async (key, type) => {
      const v = store.get(key) ?? null;
      return v !== null && type === 'json' ? JSON.parse(v) : v;
    },
    put: async (key, value) => { store.set(key, value); },
  };
};

function insertReport(db, { id, slug, query }, retiredAt = null) {
  db.prepare(`INSERT INTO research (id, slug, query, status, category, summary, result, sources,
      created_at, completed_at, retired_at)
    VALUES (?1, ?2, ?3, 'complete', 'Kitchen', 'A summary.', ?4, '[]', 1800000000, 1800000000, ?5)`)
    .run(id, slug, query, REPORT_RESULT, retiredAt);
  db.prepare(`INSERT INTO products (id, research_id, name, rank, pros, cons)
    VALUES (?1, ?2, 'Product A', 1, '[]', '[]')`).run(`${id}-p1`, id);
  db.prepare(`INSERT INTO user_searches (user_id, research_id, query, created_at)
    VALUES (?1, ?2, ?3, 1800000000)`).run(USER_ID, id, query);
}

function seededEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  insertReport(db, LIVE);
  insertReport(db, RETIRED, RETIRED_AT);
  return { DB: d1(db), KV: memoryKv(), IP_HASH_SALT: 'test-salt' };
}

async function ogCases(eq) {
  const env = seededEnv();
  const missingSvg = await (await generateOgImage(MISSING.slug, env)).text();
  const retiredRes = await generateOgImage(RETIRED.slug, env);
  const retiredSvg = await retiredRes.text();
  const liveSvg = await (await generateOgImage(LIVE.slug, env)).text();
  eq('og.svg: a live report still gets its own card', liveSvg !== missingSvg, true);
  eq('og.svg: a retired report gets the same answer as a missing one', retiredSvg === missingSvg, true);
  eq('og.svg: a retired report title is not drawn', retiredSvg.includes('Espresso'), false);
}

async function reportCases(eq) {
  const env = seededEnv();
  const missing = await handleGetReport(MISSING.id, env);
  const missingBody = await missing.json();
  eq('api/report: a live report is served', (await handleGetReport(LIVE.id, env)).status, 200);
  for (const [name, key] of [['id', RETIRED.id], ['slug', RETIRED.slug]]) {
    const res = await handleGetReport(key, env);
    eq(`api/report: retired by ${name} has the missing-report status`, res.status, missing.status);
    eq(`api/report: retired by ${name} has the missing-report body`, await res.json(), missingBody);
  }
}

function chatRequest(slug) {
  return new Request('https://frank.test/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
    body: JSON.stringify({ slug, mode: 'ask', messages: [{ role: 'user', content: 'Which one is best?' }] }),
  });
}

// The model call must never happen for a retired report. A stub fetch records
// any attempt and fails it, so no network call leaves the test.
async function chatCases(eq) {
  const realFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = async (url) => { attempts.push(String(url)); return new Response('{}', { status: 500 }); };
  try {
    const missing = await handleChat(chatRequest(MISSING.slug), seededEnv());
    const missingBody = await missing.json();
    const retired = await handleChat(chatRequest(RETIRED.slug), seededEnv());
    eq('api/chat: retired has the missing-report status', retired.status, missing.status);
    eq('api/chat: retired has the missing-report body', await retired.json(), missingBody);
    eq('api/chat: no model call for a retired report', attempts.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function historyCases(eq) {
  const env = seededEnv();
  const slugs = (await getUserSearches(env.DB, USER_ID, 50)).map((r) => r.slug);
  eq('history: a live report is listed', slugs.includes(LIVE.slug), true);
  eq('history: a retired report is not listed', slugs.includes(RETIRED.slug), false);
  eq('history: no row left behind without a slug', slugs.includes(null), false);
}

export async function runRetiredReportsTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  await ogCases(eq);
  await reportCases(eq);
  await chatCases(eq);
  await historyCases(eq);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runRetiredReportsTests();
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.log(`retired-reports: ${report.passed}/${report.passed + report.failed} passed`);
  process.exit(report.failed > 0 ? 1 : 0);
}
