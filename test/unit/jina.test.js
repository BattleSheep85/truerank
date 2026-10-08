// Retry-on-429/5xx coverage for worker/lib/jina.js's fetchPageContent. Uses
// the injectable fetchImpl/sleepImpl opts (see jina.js) so this is a pure,
// network-free, wait-free unit test — no real timers, no real requests.
import { fetchPageContent } from '../../worker/lib/jina.js';
import * as jina from '../../worker/lib/jina.js';

// Read the Authorization header from a fetch init (plain object or Headers).
function authOf(init) {
  const h = init?.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get('Authorization') ?? undefined;
  return h.Authorization ?? h.authorization;
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

// A fetchImpl stub that returns a scripted sequence of responses per call,
// keyed by URL host (r.jina.ai vs the direct-fetch fallback URL).
function scriptedFetch(jinaResponses, directResponse) {
  let jinaCall = 0;
  return async (url) => {
    if (url.startsWith('https://r.jina.ai/')) {
      const next = jinaResponses[jinaCall] ?? jinaResponses[jinaResponses.length - 1];
      jinaCall++;
      if (next instanceof Error) throw next;
      return next;
    }
    // Direct fallback request.
    if (directResponse instanceof Error) throw directResponse;
    return directResponse ?? jsonResponse(200, '<html><body>fallback body text here, long enough to pass the 100-char floor for real</body></html>');
  };
}

const noopSleep = async () => {}; // no-op sleep — test never actually waits

export async function runJinaTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  const longBody = 'x'.repeat(200); // > 100 chars so it passes the Jina body-length floor

  // ── first-try 200 → no retry, no fallback ──────────────────────────────
  {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      ok('first-try 200: hits jina host', url.startsWith('https://r.jina.ai/'));
      return jsonResponse(200, longBody);
    };
    let slept = 0;
    const sleepImpl = async () => { slept++; };
    const result = await fetchPageContent('https://example.com/a', null, { fetchImpl, sleepImpl });
    eq('first-try 200: returns body', result, longBody);
    eq('first-try 200: exactly one fetch call', calls, 1);
    eq('first-try 200: never slept/retried', slept, 0);
  }

  // ── 429, 429, 200 → retries twice then succeeds, no fallback ───────────
  {
    let jinaCalls = 0;
    let directCalls = 0;
    let sleeps = [];
    const fetchImpl = async (url) => {
      if (url.startsWith('https://r.jina.ai/')) {
        jinaCalls++;
        if (jinaCalls <= 2) return jsonResponse(429, '');
        return jsonResponse(200, longBody);
      }
      directCalls++;
      return jsonResponse(200, '<html><body>should not be reached</body></html>');
    };
    const sleepImpl = async (ms) => { sleeps.push(ms); };
    const result = await fetchPageContent('https://example.com/b', 'test-key', { fetchImpl, sleepImpl });
    eq('429,429,200: returns the eventual 200 body', result, longBody);
    eq('429,429,200: three jina attempts', jinaCalls, 3);
    eq('429,429,200: retried exactly twice (slept twice)', sleeps.length, 2);
    ok('429,429,200: never fell through to direct fetch', directCalls === 0);
    ok('429,429,200: backoff increases (first < second)', sleeps[0] < sleeps[1]);
  }

  // ── persistent 429 → exhausts retries, falls back to direct fetch, never hangs ──
  {
    let jinaCalls = 0;
    let sleeps = 0;
    const fetchImpl = scriptedFetch(
      [jsonResponse(429, ''), jsonResponse(429, ''), jsonResponse(429, '')],
      jsonResponse(200, '<html><body>' + 'y'.repeat(150) + '</body></html>'),
    );
    const wrapped = async (url, init) => { if (url.startsWith('https://r.jina.ai/')) jinaCalls++; return fetchImpl(url, init); };
    const sleepImpl = async () => { sleeps++; };
    const result = await fetchPageContent('https://example.com/c', null, { fetchImpl: wrapped, sleepImpl });
    eq('persistent 429: capped at MAX_RETRIES+1 jina attempts', jinaCalls, 3); // 1 initial + 2 retries
    eq('persistent 429: slept for each retry (bounded, not hung)', sleeps, 2);
    ok('persistent 429: falls back to direct-fetch body (non-empty)', result.length > 0);
    ok('persistent 429: fallback content came from direct fetch', result.includes('yyyy'));
  }

  // ── persistent network error → retries, then falls back to empty on double failure ──
  {
    let jinaCalls = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://r.jina.ai/')) { jinaCalls++; throw new Error('network down'); }
      throw new Error('direct also down');
    };
    const sleepImpl = noopSleep;
    const result = await fetchPageContent('https://example.com/d', null, { fetchImpl, sleepImpl });
    eq('persistent network error: retried up to the cap', jinaCalls, 3);
    eq('persistent network error: never throws — resolves to empty string', result, '');
  }

  // ── 500 is retried like 429 ──────────────────────────────────────────────
  {
    let jinaCalls = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://r.jina.ai/')) {
        jinaCalls++;
        if (jinaCalls === 1) return jsonResponse(500, '');
        return jsonResponse(200, longBody);
      }
      return jsonResponse(200, '<html><body>fallback</body></html>');
    };
    const result = await fetchPageContent('https://example.com/e', null, { fetchImpl, sleepImpl: noopSleep });
    eq('5xx retried like 429: recovers on second attempt', result, longBody);
    eq('5xx retried like 429: two attempts', jinaCalls, 2);
  }

  // ── non-retryable 404 → falls through to direct fetch immediately, no retry ──
  {
    let jinaCalls = 0;
    let slept = 0;
    const fetchImpl = async (url) => {
      if (url.startsWith('https://r.jina.ai/')) { jinaCalls++; return jsonResponse(404, ''); }
      return jsonResponse(200, '<html><body>' + 'z'.repeat(150) + '</body></html>');
    };
    const sleepImpl = async () => { slept++; };
    const result = await fetchPageContent('https://example.com/f', null, { fetchImpl, sleepImpl });
    eq('404 is not retried: single jina attempt', jinaCalls, 1);
    eq('404 is not retried: no sleep/backoff', slept, 0);
    ok('404 falls back to direct fetch', result.includes('zzzz'));
  }

  // ── jina key out of credit (D6): 401/402/403 with a key → one keyless retry,
  //    then the key is skipped for JINA_KEY_COOLDOWN_MS ────────────────────
  await runKeyOutOfCreditCases({ eq, ok, longBody });

  // ── rerankPassages (Jina rerank API) ───────────────────────────────────
  await runRerankCases({ eq, ok, report });

  return report;
}

// Records every Jina call (url + Authorization header) and every direct call.
// `jinaStatuses` scripts the Jina responses in order; past the end, the last
// entry repeats. A 200 entry returns `okBody`.
function recordingFetch(jinaStatuses, okBody) {
  const jinaCalls = [];
  let directCalls = 0;
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://r.jina.ai/')) {
      const status = jinaStatuses[jinaCalls.length] ?? jinaStatuses[jinaStatuses.length - 1];
      jinaCalls.push({ url, auth: authOf(init) });
      return jsonResponse(status, status === 200 ? okBody : '');
    }
    directCalls++;
    return jsonResponse(200, '<html><body>' + 'd'.repeat(150) + '</body></html>');
  };
  return { fetchImpl, jinaCalls, directCount: () => directCalls };
}

// Run fn with Date.now shifted by offsetMs; always restores the real clock.
async function withClockOffset(offsetMs, fn) {
  const realNow = Date.now;
  Date.now = () => realNow() + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

function resetKeyState() {
  if (typeof jina.resetJinaKeyState === 'function') jina.resetJinaKeyState();
}

async function runKeyOutOfCreditCases({ eq, ok, longBody }) {
  const P = 'jina key out of credit';
  const KEY = 'test-key';
  const cooldownMs = jina.JINA_KEY_COOLDOWN_MS ?? 600000;

  eq(`${P}: JINA_KEY_COOLDOWN_MS is 10 minutes`, jina.JINA_KEY_COOLDOWN_MS, 600000);
  ok(`${P}: exports resetJinaKeyState()`, typeof jina.resetJinaKeyState === 'function');

  // 401, 402, 403 with a key → retry the same URL once without the key.
  for (const status of [402, 401, 403]) {
    resetKeyState();
    const rec = recordingFetch([status, 200], longBody);
    const result = await fetchPageContent('https://example.com/credit', KEY, {
      fetchImpl: rec.fetchImpl, sleepImpl: noopSleep,
    });
    eq(`${P}: ${status} → two jina calls`, rec.jinaCalls.length, 2);
    eq(`${P}: ${status} → first call sends the key`, rec.jinaCalls[0]?.auth, `Bearer ${KEY}`);
    eq(`${P}: ${status} → retry targets the same URL`, rec.jinaCalls[1]?.url, rec.jinaCalls[0]?.url);
    eq(`${P}: ${status} → retry sends no Authorization header`, rec.jinaCalls[1]?.auth, undefined);
    eq(`${P}: ${status} → returns the keyless content`, result, longBody);
    eq(`${P}: ${status} → no direct-fetch fallback`, rec.directCount(), 0);
  }

  // After a 402, calls within the cooldown skip the key; after it, the key returns.
  {
    resetKeyState();
    const first = recordingFetch([402, 200], longBody);
    await fetchPageContent('https://example.com/cool-1', KEY, { fetchImpl: first.fetchImpl, sleepImpl: noopSleep });

    const soon = recordingFetch([200], longBody);
    const soonResult = await fetchPageContent('https://example.com/cool-2', KEY, {
      fetchImpl: soon.fetchImpl, sleepImpl: noopSleep,
    });
    eq(`${P}: next call after 402 → one jina call`, soon.jinaCalls.length, 1);
    eq(`${P}: next call after 402 → no Authorization header`, soon.jinaCalls[0]?.auth, undefined);
    eq(`${P}: next call after 402 → returns content`, soonResult, longBody);

    const nineMin = recordingFetch([200], longBody);
    await withClockOffset(9 * 60 * 1000, () =>
      fetchPageContent('https://example.com/cool-3', KEY, { fetchImpl: nineMin.fetchImpl, sleepImpl: noopSleep }));
    eq(`${P}: 9 minutes after 402 → still no Authorization header`, nineMin.jinaCalls[0]?.auth, undefined);

    const later = recordingFetch([200], longBody);
    await withClockOffset(cooldownMs + 1000, () =>
      fetchPageContent('https://example.com/cool-4', KEY, { fetchImpl: later.fetchImpl, sleepImpl: noopSleep }));
    eq(`${P}: after the cooldown → the key is sent again`, later.jinaCalls[0]?.auth, `Bearer ${KEY}`);
  }

  // resetJinaKeyState() clears the cooldown.
  {
    resetKeyState();
    const first = recordingFetch([402, 200], longBody);
    await fetchPageContent('https://example.com/reset-1', KEY, { fetchImpl: first.fetchImpl, sleepImpl: noopSleep });
    resetKeyState();
    const after = recordingFetch([200], longBody);
    await fetchPageContent('https://example.com/reset-2', KEY, { fetchImpl: after.fetchImpl, sleepImpl: noopSleep });
    eq(`${P}: resetJinaKeyState() → the key is sent again`, after.jinaCalls[0]?.auth, `Bearer ${KEY}`);
  }

  // A 429 with a key keeps today's retry behavior and starts no cooldown.
  {
    resetKeyState();
    const sleeps = [];
    const rec = recordingFetch([429, 200], longBody);
    const result = await fetchPageContent('https://example.com/throttle', KEY, {
      fetchImpl: rec.fetchImpl, sleepImpl: async (ms) => { sleeps.push(ms); },
    });
    eq(`${P}: 429 → retried with backoff (slept once)`, sleeps.length, 1);
    eq(`${P}: 429 → both calls send the key`, rec.jinaCalls.map((c) => c.auth), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
    eq(`${P}: 429 → returns the retried content`, result, longBody);

    const next = recordingFetch([200], longBody);
    await fetchPageContent('https://example.com/throttle-2', KEY, { fetchImpl: next.fetchImpl, sleepImpl: noopSleep });
    eq(`${P}: 429 → next call still sends the key`, next.jinaCalls[0]?.auth, `Bearer ${KEY}`);
  }

  // No key: a 402 behaves as today (no retry, direct-fetch fallback).
  {
    resetKeyState();
    let slept = 0;
    const rec = recordingFetch([402, 200], longBody);
    const result = await fetchPageContent('https://example.com/nokey', null, {
      fetchImpl: rec.fetchImpl, sleepImpl: async () => { slept++; },
    });
    eq(`${P}: no key, 402 → single jina call`, rec.jinaCalls.length, 1);
    eq(`${P}: no key, 402 → no Authorization header`, rec.jinaCalls[0]?.auth, undefined);
    eq(`${P}: no key, 402 → no backoff`, slept, 0);
    ok(`${P}: no key, 402 → falls back to direct fetch`, rec.directCount() === 1 && result.includes('dddd'));
  }

  resetKeyState();
}

// rerankPassages: one POST to the rerank API, results sorted best first, a
// clear Error on failure that never holds the key.
async function runRerankCases({ eq, ok, report }) {
  const P = 'rerankPassages';
  const KEY = 'jina-secret-key-123';
  const rerank = jina.rerankPassages;
  if (typeof rerank !== 'function') {
    report.failed++;
    report.failures.push(`${P}: worker/lib/jina.js does not export rerankPassages()`);
    return;
  }
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body });
  const errorOf = async (fn) => { try { await fn(); return null; } catch (err) { return err; } };

  {
    const calls = [];
    const usage = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return reply(200, { model: 'jina-reranker-v3.5', usage: { total_tokens: 99 }, results: [
        { index: 2, relevance_score: 0.1 }, { index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: -0.2 }, { index: 7, relevance_score: 0.9 },
      ] });
    };
    const out = await rerank({ apiKey: KEY, query: 'battery 30 hours', passages: ['a', 'b', 'c'], topN: 2, fetchImpl, onUsage: (u) => usage.push(u) });
    eq(`${P}: one POST to the rerank endpoint`, calls.map((c) => [c.url, c.init.method]), [['https://api.jina.ai/v1/rerank', 'POST']]);
    eq(`${P}: bearer key header`, authOf(calls[0]?.init), `Bearer ${KEY}`);
    eq(`${P}: request body`, calls[0]?.body, { model: 'jina-reranker-v3.5', query: 'battery 30 hours', documents: ['a', 'b', 'c'], top_n: 2, return_documents: false });
    eq(`${P}: sorted best first, out-of-range index dropped, topN kept`, out, [{ index: 0, score: 0.8 }, { index: 2, score: 0.1 }]);
    eq(`${P}: onUsage gets the token count`, usage[0]?.totalTokens, 99);
  }

  {
    let calls = 0;
    const out = await rerank({ apiKey: KEY, query: 'q', passages: [], fetchImpl: async () => { calls++; return reply(200, { results: [] }); } });
    eq(`${P}: no passages → [] and no call`, [out, calls], [[], 0]);
  }

  {
    const err = await errorOf(() => rerank({ apiKey: '', query: 'q', passages: ['a'], fetchImpl: async () => reply(200, { results: [] }) }));
    ok(`${P}: a missing key throws`, err instanceof Error && /no Jina API key/.test(err.message));
  }

  {
    const fetchImpl = async () => reply(401, { detail: `invalid token Bearer ${KEY}` });
    const err = await errorOf(() => rerank({ apiKey: KEY, query: 'q', passages: ['a'], fetchImpl }));
    ok(`${P}: an HTTP failure throws an Error with the status`, err instanceof Error && err.message.includes('HTTP 401'));
    ok(`${P}: the key is never in the error text`, err instanceof Error && !err.message.includes(KEY) && !String(err.stack).includes(KEY));
  }

  {
    const err = await errorOf(() => rerank({ apiKey: KEY, query: 'q', passages: ['a'], fetchImpl: async () => reply(200, { detail: 'x' }) }));
    ok(`${P}: a body without results throws`, err instanceof Error && /no results/.test(err.message));
  }
}
