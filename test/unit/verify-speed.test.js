// Verify speed (2026-10-09): stage deadlines, parallel claim page reads, the
// shared evidence reader, hedged model calls, and the judge caps. Every case
// uses fake reads, a fake fetch, or fake timers: no network, no real waits
// longer than a few milliseconds.
//
// Called from runVerifyTests (test/unit/verify.test.js), so the suite runs in
// scripts/run-tests.mjs without a change to that runner.
import * as deadline from '../../worker/lib/deadline.js';
import * as resolveModule from '../../worker/engine/verify-resolve.js';
import * as verifyModule from '../../worker/engine/verify.js';
import { fetchPageContent } from '../../worker/lib/jina.js';
import { ENGINE_CONFIG } from '../../worker/lib/engine-config.js';

// A page that passes isUsableClaimPage: many spec values and prose lines.
const SPEC_PAGE = [
  'Acme Buds Pro wireless earbuds with adaptive noise cancelling and a long battery life for travel.',
  'Battery life: up to 10 hours per charge with noise cancelling on, and up to 50 hours with the case.',
  'Fast charging: a 5 minute charge gives 4 hours of playtime when you are in a hurry to leave.',
  'Drivers: 11 mm custom drivers with LDAC and Hi-Res Audio Wireless for detailed sound at all volumes.',
  'Noise cancelling reduces ambient noise by up to 98% with six microphones and AI call noise reduction.',
  'Bluetooth 5.3 with multipoint connection to two devices at the same time, and a 30 m range.',
  'Water resistance: IPX4 rated against splashes and sweat, so the earbuds are fine for a workout.',
  'Each earbud weighs 5.5 g, and the charging case supports wireless charging on any Qi pad.',
].join('\n');

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake timer pair: timers fire only when fire() is called.
function fakeTimers() {
  const timers = new Map();
  let next = 1;
  return {
    setTimer: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id);
    },
    fire: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, t] of due) t.fn();
    },
    pending: () => timers.size,
  };
}

// A read that waits until released (or until its signal aborts), then fills
// the source with `content`.
function gatedRead(contentFor) {
  const gates = new Map();
  const started = [];
  const read = (source, _env, { signal } = {}) => {
    started.push(source.url);
    return new Promise((resolve) => {
      const finish = (content) => {
        if (content) Object.assign(source, { content });
        resolve(source);
      };
      gates.set(source.url, () => finish(contentFor(source.url)));
      signal?.addEventListener('abort', () => finish(''), { once: true });
    });
  };
  return { read, started, release: (url) => gates.get(url)?.() };
}

export async function runVerifySpeedTests({ eq, ok, report }) {
  const guarded = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      report.failed++;
      report.failures.push(`verify speed: ${name}: threw ${err instanceof Error ? err.stack || err.message : String(err)}`);
    }
  };

  // ── deadline.js ──────────────────────────────────────────────────────────
  await guarded('deadlineSignal', async () => {
    const timers = fakeTimers();
    const { signal, cancel } = deadline.deadlineSignal(5000, timers);
    eq('deadlineSignal: not aborted before its timer', signal.aborted, false);
    timers.fire();
    eq('deadlineSignal: aborted when its timer fires', signal.aborted, true);
    eq('deadlineSignal: the reason is a DeadlineError', signal.reason?.name, 'DeadlineError');
    cancel();

    const parent = new AbortController();
    const child = deadline.deadlineSignal(5000, { ...fakeTimers(), parent: parent.signal });
    parent.abort(new Error('run stopped'));
    eq('deadlineSignal: aborts when the parent aborts', child.signal.aborted, true);

    const timers2 = fakeTimers();
    const early = deadline.deadlineSignal(5000, timers2);
    early.cancel();
    eq('deadlineSignal: cancel() clears the timer', timers2.pending(), 0);
  });

  await guarded('anySignal', async () => {
    eq('anySignal: no signal gives undefined', deadline.anySignal([null, undefined]), undefined);
    const a = new AbortController();
    eq('anySignal: one signal is returned as is', deadline.anySignal([a.signal, null]), a.signal);
    const b = new AbortController();
    const both = deadline.anySignal([a.signal, b.signal]);
    b.abort();
    eq('anySignal: aborts when any input aborts', both.aborted, true);
  });

  await guarded('runPoolUntil', async () => {
    let inFlight = 0;
    let peak = 0;
    const thunks = [30, 5, 20, 1, 10].map((ms, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(ms);
      inFlight--;
      return i;
    });
    eq('runPoolUntil: no signal runs every thunk in input order', await deadline.runPoolUntil(thunks, 2), [0, 1, 2, 3, 4]);
    eq('runPoolUntil: at most `limit` at once', peak, 2);

    const stop = new AbortController();
    const startedIdx = [];
    const slow = [0, 1, 2, 3].map((i) => (signal) => async () => {
      startedIdx.push(i);
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      return `late ${i}`;
    });
    const pool = deadline.runPoolUntil(slow.map((f) => f(stop.signal)), 2, { signal: stop.signal, graceMs: 0, onMissing: (i) => `snippet ${i}` });
    await tick(1);
    stop.abort();
    const out = await pool;
    eq('runPoolUntil: a thunk not started at the abort never starts', startedIdx, [0, 1]);
    eq('runPoolUntil: the started thunks that settle in the grace keep their result, the others get onMissing', out, ['late 0', 'late 1', 'snippet 2', 'snippet 3']);

    const hang = new AbortController();
    const hung = deadline.runPoolUntil([() => new Promise(() => {}), async () => 'fast'], 2, {
      signal: hang.signal,
      graceMs: 5,
      onMissing: () => 'missing',
    });
    await tick(1);
    hang.abort();
    eq('runPoolUntil: a thunk that ignores the signal is dropped after graceMs', await hung, ['missing', 'fast']);

    const errors = await deadline.runPoolUntil([async () => { throw new Error('boom'); }], 1, { onError: (err, i) => `${i}:${err.message}` });
    eq('runPoolUntil: a throwing thunk gives onError(err, index)', errors, ['0:boom']);
  });

  await guarded('hedged', async () => {
    const timers = fakeTimers();
    const calls = [];
    const resolvers = [];
    const start = () => new Promise((resolve) => {
      calls.push(calls.length);
      resolvers.push(resolve);
    });
    let hedges = 0;
    const result = deadline.hedged(start, 6000, { ...timers, onHedge: () => hedges++ });
    await tick();
    eq('hedged: one call before the hedge time', calls.length, 1);
    timers.fire();
    await tick();
    eq('hedged: a second call when the first has no reply by then', calls.length, 2);
    eq('hedged: onHedge runs once', hedges, 1);
    resolvers[1]('second');
    eq('hedged: the first reply wins', await result, 'second');

    const fast = deadline.hedged(async () => 'only', 6000, fakeTimers());
    eq('hedged: a fast reply needs no second call', await fast, 'only');

    let failCalls = 0;
    const failing = deadline.hedged(async () => {
      failCalls++;
      throw new Error('upstream 502');
    }, 6000, fakeTimers());
    let failed = null;
    try { await failing; } catch (err) { failed = err.message; }
    eq('hedged: a first call that fails before the hedge rejects at once (no retry)', [failed, failCalls], ['upstream 502', 1]);

    const timers3 = fakeTimers();
    const rejections = [];
    const results3 = deadline.hedged(() => new Promise((_, reject) => rejections.push(reject)), 10, timers3);
    await tick();
    timers3.fire();
    await tick();
    rejections[0](new Error('first'));
    await tick();
    let pending = true;
    results3.catch(() => {}).finally(() => { pending = false; });
    await tick();
    eq('hedged: one failure of two started calls still waits for the other', pending, true);
    rejections[1](new Error('second'));
    let both = null;
    try { await results3; } catch (err) { both = err.message; }
    eq('hedged: both failed rejects with the first error', both, 'first');
  });

  // ── jina.js: the caller's stop signal ────────────────────────────────────
  await guarded('fetchPageContent stop signal', async () => {
    let calls = 0;
    const stopped = new AbortController();
    stopped.abort();
    const out = await fetchPageContent('https://example.com/a', 'k', { fetchImpl: async () => { calls++; return new Response('x'.repeat(500)); }, signal: stopped.signal });
    eq('fetchPageContent: an aborted stop signal reads nothing', [out, calls], ['', 0]);

    const stop = new AbortController();
    const urls = [];
    const fetchImpl = (url, init) => {
      urls.push(url);
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason ?? new Error('aborted')), { once: true });
      });
    };
    const silence = console.log;
    console.log = () => {};
    try {
      const pending = fetchPageContent('https://example.com/b', 'k', { fetchImpl, signal: stop.signal, sleepImpl: async () => {} });
      await tick();
      stop.abort();
      eq('fetchPageContent: a stop during the read returns empty text', await pending, '');
    } finally {
      console.log = silence;
    }
    eq('fetchPageContent: no retry and no direct fallback after a stop', urls, ['https://r.jina.ai/https://example.com/b']);
  });

  // ── verify-resolve.js: parallel claim page reads ─────────────────────────
  const product = 'Acme Buds Pro';
  const cand = (path, host = 'https://www.acme.com') => ({ url: `${host}${path}`, title: 'Acme Buds Pro', content: '' });
  const quiet = async (fn) => {
    const original = console.log;
    console.log = () => {};
    try { return await fn(); } finally { console.log = original; }
  };

  await guarded('readClaimPages reads at once and returns early', async () => {
    const candidates = [cand('/buds-pro'), cand('/buds-pro/specs'), cand('/dp/B0', 'https://www.amazon.com'), cand('/p/1', 'https://www.walmart.com')];
    const gate = gatedRead(() => SPEC_PAGE);
    const run = quiet(() => resolveModule.readClaimPages(candidates, {}, { wanted: 2, maxReads: 4, read: gate.read, focusedRead: async () => '' }));
    await tick();
    eq('readClaimPages: every read in the window starts at once', gate.started.length, 4);
    gate.release(candidates[0].url);
    gate.release(candidates[1].url);
    const result = await run;
    eq('readClaimPages: returns when the first two usable pages are known, before the slower reads end', result.pages.map((p) => p.url), [candidates[0].url, candidates[1].url]);
    eq('readClaimPages: reads used and next index', [result.readsUsed, result.nextIndex], [4, 4]);
    gate.release(candidates[2].url);
    gate.release(candidates[3].url);
    const spares = await result.spares;
    eq('readClaimPages: spares are the later usable pages', spares.pages.map((p) => p.url), [candidates[2].url, candidates[3].url]);
    eq('readClaimPages: the candidates do not change', candidates.map((c) => c.content), ['', '', '', '']);
  });

  await guarded('readClaimPages waits for a better ranked read, with patience', async () => {
    const candidates = [cand('/buds-pro'), cand('/support/buds-pro'), cand('/dp/B0', 'https://www.amazon.com')];
    const gate = gatedRead(() => SPEC_PAGE);
    let settled = false;
    const run = quiet(() => resolveModule.readClaimPages(candidates, {}, { wanted: 2, maxReads: 4, read: gate.read, focusedRead: async () => '', patienceMs: 30 }))
      .then((r) => { settled = true; return r; });
    await tick();
    gate.release(candidates[0].url);
    gate.release(candidates[2].url);
    await tick(5);
    eq('readClaimPages: waits for a better ranked read inside its patience', settled, false);
    const result = await run;
    eq('readClaimPages: after its patience, takes the usable pages it has', result.pages.map((p) => p.url), [candidates[0].url, candidates[2].url]);
    gate.release(candidates[1].url);
    eq('readClaimPages: the slow read becomes a spare', (await result.spares).pages.map((p) => p.url), [candidates[1].url]);
  });

  await guarded('readClaimPages runs the focused read with the shared read', async () => {
    const candidates = [cand('/buds-pro')];
    let sharedSignal = null;
    const hangingRead = (_source, _env, { signal } = {}) => new Promise((resolve) => {
      sharedSignal = signal;
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    const slowShared = await quiet(() => resolveModule.readClaimPages(candidates, { JINA_API_KEY: 'k' }, { wanted: 1, maxReads: 1, read: hangingRead, focusedRead: async () => SPEC_PAGE, sharedWaitMs: 5 }));
    eq('readClaimPages: a usable focused read is used when the shared read does not answer in sharedWaitMs', slowShared.pages.map((p) => p.content === SPEC_PAGE), [true]);
    eq('readClaimPages: the slower read is stopped', sharedSignal?.aborted, true);

    const sharedText = `${SPEC_PAGE}\nShared reader text.`;
    const lateShared = async (source) => {
      await tick(10);
      source.content = sharedText;
    };
    const preferred = await quiet(() => resolveModule.readClaimPages(candidates, {}, { wanted: 1, maxReads: 1, read: lateShared, focusedRead: async () => SPEC_PAGE, sharedWaitMs: 500 }));
    eq('readClaimPages: a usable shared read that comes a little later still wins (the text extraction is tuned on)', preferred.pages.map((p) => p.content), [sharedText]);

    const unusableShared = await quiet(() => resolveModule.readClaimPages(candidates, {}, { wanted: 1, maxReads: 1, read: async (source) => { source.content = 'Access denied'; }, focusedRead: async () => { await tick(10); return SPEC_PAGE; } }));
    eq('readClaimPages: an unusable shared read takes the focused text', unusableShared.pages.map((p) => p.content === SPEC_PAGE), [true]);
  });

  await guarded('readClaimPages stage deadline', async () => {
    const candidates = [cand('/buds-pro'), cand('/dp/B0', 'https://www.amazon.com')];
    const gate = gatedRead(() => SPEC_PAGE);
    const stage = new AbortController();
    const run = quiet(() => resolveModule.readClaimPages(candidates, {}, { wanted: 2, maxReads: 4, read: gate.read, focusedRead: async () => '', signal: stage.signal }));
    await tick();
    gate.release(candidates[1].url);
    await tick();
    stage.abort();
    const result = await run;
    eq('readClaimPages: a read still running at the deadline counts as unusable', result.pages.map((p) => p.url), [candidates[1].url]);
    eq('readClaimPages: its reject reason is the snippet text', result.rejected.map((r) => r.reason), ['too-short']);
  });

  await guarded('extractProductClaims uses the spare reads', async () => {
    const first = { ...cand('/buds-pro'), content: SPEC_PAGE };
    const spare = { ...cand('/dp/B0', 'https://www.amazon.com'), content: SPEC_PAGE };
    let reads = 0;
    const replies = [
      { claims: [{ text: 'Up to 10 hours per charge', type: 'spec' }] },
      { claims: ['10 hours per charge', '50 hours with the case', '11 mm drivers', 'Bluetooth 5.3'].map((text) => ({ text, type: 'spec' })) },
    ];
    const extracted = await verifyModule.extractProductClaims({
      product,
      resolved: { claimSources: [first], candidates: [first, spare], nextIndex: 2, readsLeft: 0, spares: Promise.resolve({ pages: [spare], rejected: [] }) },
      env: {},
      apiKey: 'k',
      model: 'm',
      callLLM: async () => ({ choices: [{ message: { content: JSON.stringify(replies.shift()) } }], usage: { cost: 0 } }),
      read: async () => { reads++; },
      focusedRead: async () => '',
    });
    eq('extractProductClaims: a thin first pass takes the spare page without a new read', [extracted.claims.length, reads], [4, 0]);
    eq('extractProductClaims: the retry extracts from both pages', extracted.claimSources.map((c) => c.url), [first.url, spare.url]);
  });

  // ── verify-resolve.js: test page reads, gather picks, shared reader ──────
  await guarded('readTestPages concurrency and deadline', async () => {
    const picks = Array.from({ length: 6 }, (_, i) => ({ url: `https://lab${i}.example/acme-buds-pro-review`, title: 'Acme Buds Pro review', content: 'snippet' }));
    eq('testReadConcurrency: every test page at once with a Jina key', resolveModule.testReadConcurrency({ JINA_API_KEY: 'k' }), resolveModule.MAX_TEST_PAGE_READS);
    eq('testReadConcurrency: two at a time without a key', resolveModule.testReadConcurrency({}), 2);

    const gate = gatedRead((url) => `${url} full test text. ${'In our test it lasted 9 hours. '.repeat(80)}`);
    const stage = new AbortController();
    const run = quiet(() => resolveModule.readTestPages(picks, {}, gate.read, { signal: stage.signal, graceMs: 0 }));
    await tick();
    eq('readTestPages: without a key, two reads at once', gate.started.length, 2);
    gate.release(picks[0].url);
    await tick();
    stage.abort();
    const { pages, filled } = await run;
    eq('readTestPages: a page read before the deadline has its text', pages[0].content.startsWith(picks[0].url), true);
    eq('readTestPages: pages not read keep their snippet (the same source)', pages.slice(1).every((p, i) => p === picks[i + 1]), true);
    eq('readTestPages: no read starts after the deadline', gate.started.length, 3);
    eq('readTestPages: filled counts the page reads with text', filled, 1);
  });

  await guarded('evidencePagesToRead', async () => {
    const speaker = 'Acme Flip 7';
    const src = (url, title, score, content = 'snippet') => ({ url, title, content, credibility: { score } });
    const sources = [
      src('https://www.rtings.com/projector/reviews/tcl/a1s', 'TCL A1s review', 90),
      src('https://www.lab.example/acme-flip-7-review', 'Acme Flip 7 review', 60),
      src('https://www.acme.com/flip-7', 'Acme Flip 7', 95),
      src('https://www.youtube.com/watch?v=1', 'Acme Flip 7 review', 80),
      src('https://www.lab.example/acme-flip-6-review', 'Acme Flip 6 review', 85),
      src('https://www.blog.example/acme-flip-7', 'Acme Flip 7 long term', 70),
      src('https://www.blog.example/acme-flip-7?ref=x', 'Acme Flip 7 long term', 70),
      src('https://www.spam.example/acme-flip-7', 'Acme Flip 7 deal', 20),
      src('https://www.done.example/acme-flip-7', 'Acme Flip 7', 80, 'x'.repeat(2000)),
    ];
    eq(
      'evidencePagesToRead: pages that name the product first, then by score; no own site, video, other model, low score, read page, or second copy',
      resolveModule.evidencePagesToRead(sources, speaker).map((s) => s.url),
      ['https://www.blog.example/acme-flip-7', 'https://www.lab.example/acme-flip-7-review', 'https://www.rtings.com/projector/reviews/tcl/a1s'],
    );
    eq('evidencePagesToRead: max caps the picks', resolveModule.evidencePagesToRead(sources, speaker, { max: 1 }).length, 1);
  });

  await guarded('evidenceReader', async () => {
    let reads = 0;
    const read = async (source) => {
      reads++;
      source.content = `${source.url} ${'full page text '.repeat(200)}`;
      source.credibility = { score: 77 };
    };
    const readPage = resolveModule.evidenceReader({}, { read });
    const fromTests = { url: 'https://www.lab.example/acme-buds-pro-review', title: 'Test search title', content: 'snippet a' };
    const fromGather = { url: 'https://www.lab.example/acme-buds-pro-review/', title: 'Gather title', content: 'snippet b', source: 'web' };
    const [a, b] = await Promise.all([readPage(fromTests), readPage(fromGather)]);
    eq('evidenceReader: a page both find is read once', reads, 1);
    eq('evidenceReader: each caller keeps its own fields, with the read text', [a.title, b.title, b.source, b.content === a.content, b.credibility.score], ['Test search title', 'Gather title', 'web', true, 77]);
    eq('evidenceReader: the inputs do not change', [fromTests.content, fromGather.content], ['snippet a', 'snippet b']);

    const empty = resolveModule.evidenceReader({}, { read: async () => {} });
    const kept = { url: 'https://www.x.example/acme-buds-pro', content: 'snippet' };
    eq('evidenceReader: a read without text gives the caller its own source', (await empty(kept)) === kept, true);
  });

  // ── verify.js: budget, judge caps, fallback on a failed primary ──────────
  await guarded('verifyBudget and ENGINE_CONFIG knobs', async () => {
    eq('verifyBudget: unset, zero, and negative knobs are 0 (no deadline)', verifyModule.verifyBudget({ verifyTestReadMs: 0, verifyGatherReadMs: -5 }), {
      resolveReadMs: 0, testReadMs: 0, gatherReadMs: 0, plannerMs: 0, stanceCallMs: 0, claimPatienceMs: 0, hedgeMs: 0, extractHedgeMs: 0, overlapGather: false,
    });
    eq('verifyBudget: positive knobs pass through', verifyModule.verifyBudget({ verifyResolveReadMs: 15000, verifyClaimPatienceMs: 3000, verifyOverlapGather: true }).resolveReadMs, 15000);
    const budget = verifyModule.verifyBudget(ENGINE_CONFIG);
    // Ship rule outcome (2026-10-09): no clean 6-product round met both bars,
    // so the stage deadlines stay off by default; the speedups that keep the
    // evidence (overlap, hedges) are on.
    eq('ENGINE_CONFIG: stage deadlines, caps, and patience are off by default', [budget.resolveReadMs, budget.testReadMs, budget.gatherReadMs, budget.plannerMs, budget.stanceCallMs, budget.claimPatienceMs], [0, 0, 0, 0, 0, 0]);
    eq('ENGINE_CONFIG: the gather starts with the check, and both hedges are on', [budget.overlapGather, budget.hedgeMs > 0, budget.extractHedgeMs > 0], [true, true, true]);
  });

  await guarded('extractClaims hedge', async () => {
    let calls = 0;
    const reply = (text) => ({ choices: [{ message: { content: JSON.stringify({ claims: [{ text, type: 'spec' }] }) } }], usage: { cost: 0.001 } });
    const slowFirst = async () => {
      calls++;
      if (calls === 1) {
        await tick(60);
        return reply('from the first call');
      }
      return reply('from the second call');
    };
    const out = await quiet(() => verifyModule.extractClaims({ product, claimText: SPEC_PAGE, apiKey: 'k', model: 'm', callLLM: slowFirst, hedgeMs: 5 }));
    eq('extractClaims: a slow call gets a second request, and the first reply wins', [calls, out.claims.map((c) => c.text)], [2, ['from the second call']]);
    await tick(70);
  });

  await guarded('judge caps and fallback', async () => {
    const claim = { id: 'c1', text: 'Up to 10 hours of battery life', type: 'spec' };
    const scored = [
      { url: 'https://lab.example/acme-buds-pro-review', title: 'Acme Buds Pro review', content: 'In our battery test the Acme Buds Pro lasted 10 hours.', credibility: 90, independence: 80, tags: ['hands-on'] },
    ];
    const seen = [];
    const supportReply = { choices: [{ message: { content: JSON.stringify({ verdicts: [{ url: scored[0].url, stance: 'support', span: 'In our battery test the Acme Buds Pro lasted 10 hours.' }] }) }, finish_reason: 'stop' }], usage: { cost: 0.001 } };
    const callLLM = async (_key, model, _messages, opts) => {
      seen.push({ model, hardMsOverride: opts.hardMsOverride });
      if (model === 'primary') throw new Error('The operation was aborted');
      return supportReply;
    };
    const warn = console.warn;
    console.warn = () => {};
    let result;
    try {
      result = await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM, product, hardMs: 25000 }));
    } finally {
      console.warn = warn;
    }
    eq('judgeClaim: a failed primary call is judged by the fallback model', [result.judgeModel, result.verdict.status === 'unsubstantiated'], ['second', false]);
    eq('judgeClaim: each stance call carries the cap', seen.map((s) => s.hardMsOverride), [25000, 25000]);

    let threw = false;
    try {
      await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', callLLM, product }));
    } catch {
      threw = true;
    }
    eq('judgeClaim: without a fallback model a failed primary call still throws', threw, true);

    // Fallback hedge: a slow primary starts the fallback judge early.
    const order = [];
    const neutralReply = { choices: [{ message: { content: JSON.stringify({ verdicts: [{ url: scored[0].url, stance: 'neutral', span: '' }] }) }, finish_reason: 'stop' }], usage: { cost: 0.001 } };
    const slowPrimary = (primaryReply) => async (_key, model) => {
      order.push(`start ${model}`);
      if (model === 'primary') await tick(30);
      order.push(`end ${model}`);
      return model === 'primary' ? primaryReply : supportReply;
    };
    const decided = await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM: slowPrimary(supportReply), product, hedgeMs: 5 }));
    eq('judgeClaim hedge: the fallback starts while a slow primary runs', order.slice(0, 2), ['start primary', 'start second']);
    eq('judgeClaim hedge: after the hedge the first decided verdict wins, even over a decided slow primary', decided.judgeModel, 'second');
    order.length = 0;
    const undecided = await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM: slowPrimary(neutralReply), product, hedgeMs: 5 }));
    eq('judgeClaim hedge: after the hedge the first decided verdict wins (the fallback here), with one fallback call', [undecided.judgeModel, order.filter((o) => o === 'start second').length], ['second', 1]);
    eq('judgeClaim hedge: the fallback verdict does not wait for the slow primary', order.indexOf('end second') < order.indexOf('end primary') || !order.includes('end primary'), true);
    await tick(40);

    // After the hedge, neither decided: the primary result is kept.
    const bothNeutral = async (_key, model) => {
      if (model === 'primary') await tick(20);
      return neutralReply;
    };
    const neither = await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM: bothNeutral, product, hedgeMs: 5 }));
    eq('judgeClaim hedge: neither decided keeps the primary result, with both costs', [neither.judgeModel, neither.verdict.status, neither.costUsd], ['primary', 'unsubstantiated', 0.002]);

    // After the hedge, the primary fails: the fallback verdict as it is.
    const failingPrimary = async (_key, model) => {
      if (model === 'primary') {
        await tick(20);
        throw new Error('The operation was aborted');
      }
      return neutralReply;
    };
    const failed = await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM: failingPrimary, product, hedgeMs: 5 }));
    eq('judgeClaim hedge: a failed slow primary takes the fallback result', failed.judgeModel, 'second');
    order.length = 0;
    await quiet(() => verifyModule.judgeClaim({ claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'second', callLLM: async (_k, model) => { order.push(model); return supportReply; }, product, hedgeMs: 50 }));
    await tick(60);
    eq('judgeClaim hedge: a fast primary verdict calls no fallback', order, ['primary']);

    const noCap = [];
    await quiet(() => verifyModule.classifyStance({ claim, evidence: scored, apiKey: 'k', model: 'm', callLLM: async (_k, _m, _msgs, opts) => { noCap.push('hardMsOverride' in opts); return supportReply; } }));
    eq('classifyStance: no cap unless hardMs is set', noCap, [false]);
  });
}
