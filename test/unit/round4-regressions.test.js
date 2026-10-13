// Regression tests for six small defects (CP-345, CP-346, CP-347, CP-348,
// CP-359, CP-362). Each block is named for its issue id. The LLM calls run
// against a fake fetch, so no block uses the network.
import { pathToFileURL } from 'node:url';
import { handleStartVerify } from '../../worker/handlers/verify.js';
import { parseProductInput, productNameKey } from '../../worker/lib/product-link.js';
import { renderVerifyResultPage } from '../../worker/pages/verify-page.js';
import { proposeMissingLeaders } from '../../worker/engine/extract/recall-supplement.js';
import { gatherParallel } from '../../worker/engine/parallel-engine.js';

const SITE = 'https://frank.test';
const PRODUCT = 'Sony WH-1000XM5 headphones';
const TEST_KEY = 'test-openrouter-key';
const TEST_MODEL = 'test/model';
const VERIFY_SLUG = 'acme-kettle-abcd1234';
const CONSOLE_METHODS = Object.freeze(['log', 'warn', 'error']);

// Runs fn with globalThis.fetch replaced by fake, then restores fetch.
async function withFakeFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// Runs fn while it records every console.log/warn/error line as one string.
// Returns { value, lines }.
async function withConsoleCapture(fn) {
  const saved = Object.fromEntries(CONSOLE_METHODS.map((m) => [m, console[m]]));
  const lines = [];
  for (const m of CONSOLE_METHODS) {
    console[m] = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  }
  try {
    return { value: await fn(), lines };
  } finally {
    for (const m of CONSOLE_METHODS) console[m] = saved[m];
  }
}

// A chat-completion reply whose message content is `content`.
function chatReply(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

// CP-345: only https links pass, so the error must not offer "http(s)".
async function httpLinkMessageCases(eq) {
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }) };
  const env = { IP_HASH_SALT: 'test-salt', KV: { get: async () => null, put: async () => {} }, DB: { prepare: () => stmt } };
  const request = new Request(`${SITE}/api/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: PRODUCT, productUrl: 'http://shop.example/acme-kettle' }),
  });
  const res = await handleStartVerify(request, env);
  const message = String((await res.json()).error || '');
  eq('CP-345: an http productUrl is refused with 400', res.status, 400);
  eq('CP-345: the message no longer says "http(s)"', message.includes('http(s)'), false);
  eq('CP-345: the message asks for an https link', /https/i.test(message), true);
}

// CP-346: a generic page segment is not a product name, so the identifying
// query stays; 'ref' can be the product id, so it stays too.
function genericSegmentCases(eq) {
  const phpA = parseProductInput('https://shop.example/product_info.php?products_id=123');
  const phpB = parseProductInput('https://shop.example/product_info.php?products_id=456');
  eq('CP-346: product_info.php keeps products_id in the url', String(phpA.url).includes('products_id=123'), true);
  eq('CP-346: product_info.php is not read as the name "product info"', phpA.name === 'product info', false);
  eq('CP-346: two product_info.php ids get different keys', phpA.key !== phpB.key, true);

  const detailA = parseProductInput('https://shop.example/product-detail?id=55');
  const detailB = parseProductInput('https://shop.example/product-detail?id=66');
  eq('CP-346: product-detail keeps id in the url', String(detailA.url).includes('id=55'), true);
  eq('CP-346: two product-detail ids get different keys', detailA.key !== detailB.key, true);

  const refA = parseProductInput('https://shop.example/item?ref=AB12');
  const refB = parseProductInput('https://shop.example/item?ref=CD34');
  eq('CP-346: ref stays in the url', String(refA.url).includes('ref=AB12'), true);
  eq('CP-346: two ref values get different keys', refA.key !== refB.key, true);

  const utmA = parseProductInput('https://shop.example/item?id=9&utm_source=mail');
  const utmB = parseProductInput('https://shop.example/item?id=9&utm_source=feed');
  eq('CP-346: utm_ params still never split a key', utmA.key, utmB.key);
}

// CP-347: a symbol that names a model ("+") must split the key, and a
// retargetable short link (bit.ly) must not get a URL key.
function symbolAndShortLinkCases(eq) {
  eq('CP-347: "Galaxy S24+" and "Galaxy S24" get different name keys',
    productNameKey('Galaxy S24+') !== productNameKey('Galaxy S24'), true);
  eq('CP-347: parseProductInput keys "Galaxy S24+" apart from "Galaxy S24"',
    parseProductInput('Galaxy S24+').key !== parseProductInput('Galaxy S24').key, true);
  eq('CP-347: case and spacing still share a key', productNameKey('Galaxy S24'), productNameKey('galaxy   s24'));

  const named = parseProductInput('Acme Kettle 2000 https://bit.ly/3AbCdE');
  eq('CP-347: a named bit.ly link gets the name key', named.key, productNameKey('Acme Kettle 2000'));
  const bare = parseProductInput('https://bit.ly/3AbCdE');
  eq('CP-347: a bare bit.ly link gets no URL key', String(bare.key).startsWith('verify:url:'), false);
}

function verificationEnv(result) {
  const row = {
    id: 'r1', slug: VERIFY_SLUG, kind: 'verification', status: 'complete', query: 'Acme Kettle',
    subject_url: 'https://acme.example.com/kettle', result: JSON.stringify(result),
    created_at: 1_700_000_000, completed_at: 1_700_000_100,
  };
  const stmt = { bind: () => stmt, first: async () => row, all: async () => ({ results: [] }) };
  return { DB: { prepare: () => stmt } };
}

const GOOD_EVIDENCE = Object.freeze({
  url: 'https://rtings.com/kettle', stance: 'support', credibility: 90, independence: 80, span: 'Boiled in 3 minutes.', tags: [],
});

function claimWith(supporting, contradicting) {
  return { id: 'c1', text: 'Boils in 3 minutes', claimType: 'spec', status: 'verified', supporting, contradicting };
}

const evidenceLogs = (lines) => lines.filter((l) => l.includes('verify-page') && /evidence/i.test(l));

// CP-348: dropping malformed stored evidence must leave a log line.
async function droppedEvidenceLogCases(eq) {
  const clean = await withConsoleCapture(() =>
    renderVerifyResultPage(VERIFY_SLUG, verificationEnv({ claims: [claimWith([GOOD_EVIDENCE], [])] })));
  eq('CP-348: well-formed evidence logs no drop', evidenceLogs(clean.lines).length, 0);

  const nullItem = await withConsoleCapture(() =>
    renderVerifyResultPage(VERIFY_SLUG, verificationEnv({ claims: [claimWith([GOOD_EVIDENCE, null], [])] })));
  eq('CP-348: a null evidence item is logged when dropped', evidenceLogs(nullItem.lines).length > 0, true);

  const notList = await withConsoleCapture(() =>
    renderVerifyResultPage(VERIFY_SLUG, verificationEnv({ claims: [claimWith([GOOD_EVIDENCE], { url: 'x' })] })));
  eq('CP-348: a non-list evidence field is logged when dropped', evidenceLogs(notList.lines).length > 0, true);
}

// CP-359: unparseable model JSON must log the "skipped" diagnostic again.
async function recallSkipLogCases(eq) {
  const sources = [{ title: 'Best kettles 2026', url: 'https://example.com/kettles' }];
  const { value, lines } = await withConsoleCapture(() =>
    withFakeFetch(async () => chatReply('this is not json {'), () =>
      proposeMissingLeaders('best kettle', 'electric kettle', ['Acme Kettle'], sources, TEST_KEY, TEST_MODEL)));
  eq('CP-359: unparseable reply still returns []', JSON.stringify(value), '[]');
  eq('CP-359: unparseable reply logs the skipped diagnostic',
    lines.some((l) => l.includes('[recall-supplement]') && l.includes('skipped')), true);
}

const BASE_FACETS = Object.freeze({
  needs_location: false, is_buyable: false, is_experience: false, is_content: false,
  is_service: false, is_comparative: false, sold_on_amazon: false, recency_sensitive: true,
});
const PLANNER_ASPECTS = JSON.stringify({
  aspects: [{ title: 'A', queries: ['q1'] }, { title: 'B', queries: ['q2'] }],
});

// The planner prompt (all message text) gatherParallel sends for these facets.
// The start gate closes after the planner call, so no search runs.
async function plannerPromptFor(facets) {
  const bodies = [];
  const fake = async (_url, init) => { bodies.push(JSON.parse(init.body)); return chatReply(PLANNER_ASPECTS); };
  await withConsoleCapture(() => withFakeFetch(fake, () =>
    gatherParallel('Acme Pro 3000', { plannerModel: TEST_MODEL, maxSearches: 50 }, TEST_KEY, {}, null,
      facets, 'Acme Pro 3000', {}, { withNotes: false, startGate: Promise.resolve(false) })));
  return (bodies[0]?.messages || []).map((m) => m.content).join('\n');
}

// CP-362: decompose() must see the classifier facets, so a location or
// service run does not get a product-shaped plan.
async function decomposeFacetsCases(eq) {
  const product = await plannerPromptFor({ ...BASE_FACETS, is_buyable: true, sold_on_amazon: true });
  const service = await plannerPromptFor({ ...BASE_FACETS, is_service: true });
  const place = await plannerPromptFor({ ...BASE_FACETS, is_experience: true, needs_location: true });
  eq('CP-362: fixture sanity: the planner call was captured', product.length > 0, true);
  eq('CP-362: fixture sanity: the product prompt does not mention location', /location/i.test(product), false);
  eq('CP-362: a service run gets a different planner prompt', service !== product, true);
  eq('CP-362: a service run planner prompt names the service focus', /\bservice\b/i.test(service), true);
  eq('CP-362: a location/experience run planner prompt names the location focus', /location/i.test(place), true);
}

export async function runRound4RegressionTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, actual, expected) => {
    if (actual === expected) report.passed++;
    else { report.failed++; report.failures.push(`${name} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`); }
  };
  const blocks = [
    ['CP-345', httpLinkMessageCases], ['CP-346', genericSegmentCases], ['CP-347', symbolAndShortLinkCases],
    ['CP-348', droppedEvidenceLogCases], ['CP-359', recallSkipLogCases], ['CP-362', decomposeFacetsCases],
  ];
  for (const [id, fn] of blocks) {
    try {
      await fn(eq);
    } catch (err) {
      report.failed++;
      report.failures.push(`${id}: threw ${err?.stack || err}`);
    }
  }
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runRound4RegressionTests();
  console.log(`round4-regressions: ${report.passed}/${report.passed + report.failed} passed`);
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  process.exit(report.failed > 0 ? 1 : 0);
}
