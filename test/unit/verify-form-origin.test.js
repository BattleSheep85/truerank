// Unit tests for the CSRF guard on no-JavaScript form posts to POST /api/verify.
// A cross-site form post must be refused before any work; a same-origin form
// post redirects to the check page; JSON callers keep the JSON answer; any
// other body type is refused with 415.
import { pathToFileURL } from 'node:url';
import { handleStartVerify } from '../../worker/handlers/verify.js';

const SITE = 'https://frank.test';
const ENDPOINT = `${SITE}/api/verify`;
const SAVED = Object.freeze({ id: 'saved-1', slug: 'sony-wh-1000xm5-headphones-saved1', completed_at: 1_800_000_000 });
const PRODUCT = 'Sony WH-1000XM5 headphones';
const FORM_TYPE = 'application/x-www-form-urlencoded';

// Env whose DB answers every lookup with SAVED (the free reuse path), and
// which counts how many statements were prepared.
function makeEnv() {
  const calls = { prepared: 0 };
  const stmt = { bind: () => stmt, first: async () => SAVED, all: async () => ({ results: [] }) };
  const env = {
    IP_HASH_SALT: 'test-salt',
    KV: { get: async () => null, put: async () => {} },
    DB: { prepare: () => { calls.prepared++; return stmt; } },
  };
  return { env, calls };
}

function formRequest(headers) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': FORM_TYPE, ...headers },
    body: new URLSearchParams({ product: PRODUCT }).toString(),
  });
}

async function crossSiteCases(eq) {
  const cases = [
    ['Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.test' }],
    ['Sec-Fetch-Site same-site', { 'Sec-Fetch-Site': 'same-site', Origin: 'https://sub.frank.test' }],
    ['foreign Origin, no Sec-Fetch-Site', { Origin: 'https://evil.test' }],
    ['null Origin', { Origin: 'null' }],
    ['foreign Referer only', { Referer: 'https://evil.test/page' }],
    ['same host on another port', { Origin: 'https://frank.test:8443' }],
    ['http:// Origin on the same host', { Origin: 'http://frank.test' }],
    ['http:// Referer on the same host', { Referer: 'http://frank.test/verify' }],
    ['no Sec-Fetch-Site, Origin, or Referer', {}],
  ];
  for (const [name, headers] of cases) {
    const { env, calls } = makeEnv();
    const res = await handleStartVerify(formRequest(headers), env);
    eq(`cross-site (${name}): 403`, res.status, 403);
    eq(`cross-site (${name}): JSON with a plain message`, typeof (await res.json()).error, 'string');
    eq(`cross-site (${name}): no database work`, calls.prepared, 0);
  }
}

async function sameOriginCases(eq) {
  const cases = [
    ['Sec-Fetch-Site same-origin', { 'Sec-Fetch-Site': 'same-origin', Origin: SITE }],
    ['Sec-Fetch-Site none', { 'Sec-Fetch-Site': 'none' }],
    ['matching Origin, no Sec-Fetch-Site', { Origin: SITE }],
    ['matching Referer only', { Referer: `${SITE}/verify` }],
  ];
  for (const [name, headers] of cases) {
    const { env } = makeEnv();
    const res = await handleStartVerify(formRequest(headers), env);
    eq(`same-origin (${name}): 303`, res.status, 303);
    eq(`same-origin (${name}): goes to the check page`, res.headers.get('Location'), `/verify/${SAVED.slug}`);
  }
}

async function jsonCases(eq) {
  const { env } = makeEnv();
  const request = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product: PRODUCT }),
  });
  const res = await handleStartVerify(request, env);
  const body = await res.json();
  eq('json, no Origin: 200', res.status, 200);
  eq('json, no Origin: JSON answer with the saved slug', body.slug, SAVED.slug);
  eq('json, no Origin: marked reused', body.reused, true);
}

// Only application/json and the form type reach a body reader. A text/plain
// body that parses as JSON is the classic cross-site "simple request" bypass.
async function contentTypeCases(eq) {
  const cases = [
    ['text/plain JSON-looking body', 'text/plain'],
    ['no Content-Type', null],
    ['multipart/form-data', 'multipart/form-data; boundary=x'],
  ];
  for (const [name, type] of cases) {
    const { env, calls } = makeEnv();
    const headers = type ? { 'Content-Type': type } : {};
    const request = new Request(ENDPOINT, { method: 'POST', headers, body: JSON.stringify({ product: PRODUCT }) });
    if (!type) request.headers.delete('Content-Type');
    const res = await handleStartVerify(request, env);
    eq(`content type (${name}): 415`, res.status, 415);
    eq(`content type (${name}): JSON with a plain message`, typeof (await res.json()).error, 'string');
    eq(`content type (${name}): no database work`, calls.prepared, 0);
  }

  const { env } = makeEnv();
  const charset = new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
    body: JSON.stringify({ product: PRODUCT }),
  });
  eq('content type (JSON with charset parameter): accepted', (await handleStartVerify(charset, env)).status, 200);
}

export async function runVerifyFormOriginTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  await crossSiteCases(eq);
  await sameOriginCases(eq);
  await jsonCases(eq);
  await contentTypeCases(eq);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runVerifyFormOriginTests();
  for (const f of report.failures) console.log(`  FAIL ${f}`);
  console.log(`verify-form-origin: ${report.passed}/${report.passed + report.failed} passed`);
  process.exit(report.failed > 0 ? 1 : 0);
}
