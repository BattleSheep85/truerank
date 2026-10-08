// Truth Audit pure-logic coverage: isMarketingEcho, applyStanceBackstops,
// buildClaimEvidence, topEvidenceForClaim — the deterministic backstop/join
// logic ported into worker/engine/verify.js (single source of truth, also
// used by benchmarks/verify-product.mjs).
//
// Namespace import on purpose: claimTerms and claimPassage (piece 9) can be
// missing from the module. A static named import of a missing export would
// stop scripts/run-tests.mjs from loading at all.
import * as verifyModule from '../../worker/engine/verify.js';
import * as resolveModule from '../../worker/engine/verify-resolve.js';
import * as toolsModule from '../../worker/engine/tools.js';
import * as llmModule from '../../worker/engine/llm.js';
import * as rerankModule from '../../worker/engine/verify-rerank.js';
import { verdictForClaim } from '../../worker/lib/verdict.js';

const {
  isMarketingEcho,
  spanHasGenuineTestLanguage,
  applyStanceBackstops,
  buildClaimEvidence,
  topEvidenceForClaim,
  selectSourcesToHydrate,
} = verifyModule;

// Calls an export by name. A missing export throws a clear error, which the
// caller records as one failed assertion instead of a crash of the runner.
function callExport(name, ...args) {
  const fn = verifyModule[name];
  if (typeof fn !== 'function') throw new Error(`worker/engine/verify.js does not export ${name}()`);
  return fn(...args);
}

export async function runVerifyTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── isMarketingEcho ──────────────────────────────────────────────────────
  {
    ok(
      'isMarketingEcho: verbatim manufacturer copy matching the claim → true',
      isMarketingEcho('Ultra Long 50H Playtime', 'Ultra Long 50H Playtime'),
    );
    ok(
      'isMarketingEcho: span is a longer block containing the claim phrase → true',
      isMarketingEcho('Featuring Ultra Long 50H Playtime and ANC', 'Ultra Long 50H Playtime'),
    );
    eq(
      'isMarketingEcho: real test language, not just spec restatement → false',
      isMarketingEcho('we measured 10.5h of playback in our test', 'Ultra Long 50H Playtime'),
      false,
    );
    eq('isMarketingEcho: too-short span is never a meaningful echo', isMarketingEcho('50H', 'Ultra Long 50H Playtime'), false);
    eq('isMarketingEcho: too-short claim is never a meaningful echo', isMarketingEcho('some longer span text here', 'ANC'), false);
  }

  // ── spanHasGenuineTestLanguage ───────────────────────────────────────────
  {
    ok('spanHasGenuineTestLanguage: "we measured" → true', spanHasGenuineTestLanguage('we measured 10.5h in our test'));
    ok('spanHasGenuineTestLanguage: "after testing" → true', spanHasGenuineTestLanguage('after testing for a week, battery held up'));
    eq('spanHasGenuineTestLanguage: plain spec restatement → false', spanHasGenuineTestLanguage('Ultra Long 50H Playtime'), false);
  }

  // ── applyStanceBackstops ─────────────────────────────────────────────────
  {
    eq(
      'applyStanceBackstops: manufacturer-tagged support → neutral',
      applyStanceBackstops({ stance: 'support', span: 'we measured 10.5h', tags: ['manufacturer'] }, 'battery lasts 10.5h'),
      'neutral',
    );
    eq(
      'applyStanceBackstops: sponsored-tagged support → neutral',
      applyStanceBackstops({ stance: 'support', span: 'we measured 10.5h', tags: ['sponsored-content'] }, 'battery lasts 10.5h'),
      'neutral',
    );
    eq(
      'applyStanceBackstops: span-echo support (no test language) → neutral',
      applyStanceBackstops({ stance: 'support', span: 'Ultra Long 50H Playtime', tags: ['hands-on'] }, 'Ultra Long 50H Playtime'),
      'neutral',
    );
    eq(
      'applyStanceBackstops: genuine hands-on measured span → stays support',
      applyStanceBackstops({ stance: 'support', span: 'we measured ~10.5 h of playback in our battery test', tags: ['hands-on'] }, 'battery lasts 10.5 hours'),
      'support',
    );
    eq(
      'applyStanceBackstops: never upgrades an existing neutral',
      applyStanceBackstops({ stance: 'neutral', span: 'we measured 10.5h', tags: [] }, 'battery lasts 10.5h'),
      'neutral',
    );
    eq(
      'applyStanceBackstops: never touches an existing contradict',
      applyStanceBackstops({ stance: 'contradict', span: 'we measured only 6h', tags: ['manufacturer'] }, 'battery lasts 10.5h'),
      'contradict',
    );
  }

  // ── buildClaimEvidence ───────────────────────────────────────────────────
  {
    const claim = { id: 'c1', text: 'battery lasts 10.5 hours', type: 'spec' };
    const scoredEvidence = [
      { url: 'https://expert.com/review', title: 'Expert Review', content: '...', credibility: 90, independence: 70, tags: ['hands-on', 'expert-domain'] },
      { url: 'https://mfg.com/spec', title: 'Spec Page', content: '...', credibility: 40, independence: 10, tags: ['manufacturer'] },
      { url: 'https://unmatched.com/page', title: 'Unmatched', content: '...', credibility: 60, independence: 50, tags: [] },
    ];
    const stanceRows = [
      { url: 'https://expert.com/review', stance: 'support', span: 'we measured ~10.5 h of playback in our battery test' },
      { url: 'https://mfg.com/spec', stance: 'support', span: 'Ultra Long 10.5H Playtime' },
      { url: 'https://not-in-evidence.com', stance: 'support', span: 'irrelevant' },
    ];

    const result = buildClaimEvidence(claim, scoredEvidence, stanceRows);

    eq('buildClaimEvidence: drops rows with no matching scored-evidence url', result.length, 2);
    eq(
      'buildClaimEvidence: joined urls are exactly the matched ones',
      result.map((r) => r.url).sort(),
      ['https://expert.com/review', 'https://mfg.com/spec'],
    );

    const expertRow = result.find((r) => r.url === 'https://expert.com/review');
    eq('buildClaimEvidence: genuine hands-on measurement stays support', expertRow.stance, 'support');
    eq('buildClaimEvidence: carries credibility/independence/tags from scored evidence', expertRow.credibility, 90);
    eq('buildClaimEvidence: carries the span from the stance row', expertRow.span, 'we measured ~10.5 h of playback in our battery test');

    const mfgRow = result.find((r) => r.url === 'https://mfg.com/spec');
    eq('buildClaimEvidence: manufacturer support downgraded to neutral via backstop', mfgRow.stance, 'neutral');

    eq('buildClaimEvidence: unmatched scored-evidence item (no stance row) is absent', result.some((r) => r.url === 'https://unmatched.com/page'), false);

    // Empty inputs are handled gracefully.
    eq('buildClaimEvidence: empty stance rows → empty result', buildClaimEvidence(claim, scoredEvidence, []), []);
    eq('buildClaimEvidence: non-array stance rows → empty result', buildClaimEvidence(claim, scoredEvidence, null), []);
  }

  // ── topEvidenceForClaim ──────────────────────────────────────────────────
  {
    const handsOnExpert = { url: 'https://a.com', credibility: 90, independence: 70, tags: ['hands-on', 'expert-domain'] };
    const manufacturer = { url: 'https://b.com', credibility: 50, independence: 100, tags: ['manufacturer'] };
    const listicle = { url: 'https://c.com', credibility: 50, independence: 50, tags: ['listicle'] };
    const sponsored = { url: 'https://d.com', credibility: 60, independence: 50, tags: ['sponsored-content'] };
    const communitySrc = { url: 'https://e.com', credibility: 55, independence: 60, tags: ['community'] };

    const evidence = [manufacturer, listicle, sponsored, handsOnExpert, communitySrc];
    const ranked = topEvidenceForClaim(evidence);

    eq('topEvidenceForClaim: ranks the hands-on expert source first (highest verificationWeight)', ranked[0].url, 'https://a.com');
    eq('topEvidenceForClaim: default n keeps all 5 when under the cap', ranked.length, 5);

    const limited = topEvidenceForClaim(evidence, 2);
    eq('topEvidenceForClaim: respects a custom n', limited.length, 2);
    eq('topEvidenceForClaim: n=2 still leads with the strongest source', limited[0].url, 'https://a.com');

    // Does not mutate the input array.
    const original = [...evidence];
    topEvidenceForClaim(evidence, 3);
    eq('topEvidenceForClaim: does not mutate the input array', evidence.map((e) => e.url), original.map((e) => e.url));
  }

  // ── claim-aware evidence (piece 9) ───────────────────────────────────────
  // Runs one block of assertions. An exception (for example a missing export)
  // counts as one failure, so the other suites still run.
  const guarded = (label, fn) => {
    try { fn(); } catch (err) {
      report.failed++;
      report.failures.push(`${label}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Contract 1: a source that mentions the claim terms outranks a
  // higher-weight source that mentions none of them.
  guarded('topEvidenceForClaim(claim)', () => {
    const offTopicExpert = {
      url: 'https://expert.example/review', credibility: 90, independence: 70, tags: ['hands-on', 'expert-domain'],
      content: 'Great build quality and a comfortable fit for long listening sessions.',
    };
    const onTopicCommunity = {
      url: 'https://forum.example/thread', credibility: 55, independence: 60, tags: ['community'],
      content: 'In my use the battery gave about 38 hours before it needed a charge.',
    };
    const evidence = [offTopicExpert, onTopicCommunity];
    const claim = { id: 'c1', text: 'Battery lasts up to 40 hours', type: 'spec' };

    const ranked = topEvidenceForClaim(evidence, 15, claim);
    eq('topEvidenceForClaim(claim): the source that mentions battery and hours ranks first', ranked[0]?.url, 'https://forum.example/thread');
    ok(
      'topEvidenceForClaim(claim): the higher-weight source with no term hit ranks below it',
      ranked.findIndex((e) => e.url === 'https://expert.example/review') > ranked.findIndex((e) => e.url === 'https://forum.example/thread'),
    );
    eq('topEvidenceForClaim(claim): keeps every source when under n', ranked.length, 2);
    eq('topEvidenceForClaim(claim): respects n', topEvidenceForClaim(evidence, 1, claim).map((e) => e.url), ['https://forum.example/thread']);
    eq(
      'topEvidenceForClaim(claim): does not change the input array',
      evidence.map((e) => e.url),
      ['https://expert.example/review', 'https://forum.example/thread'],
    );
  });

  // Contract 2: claim null keeps the claim-agnostic order (regression guard).
  // The expected order is the order the function gives before piece 9.
  guarded('topEvidenceForClaim(claim null)', () => {
    const evidence = [
      { url: 'https://b.com', credibility: 50, independence: 100, tags: ['manufacturer'], content: 'battery 40 hours' },
      { url: 'https://c.com', credibility: 50, independence: 50, tags: ['listicle'], content: '' },
      { url: 'https://d.com', credibility: 60, independence: 50, tags: ['sponsored-content'], content: 'battery' },
      { url: 'https://a.com', credibility: 90, independence: 70, tags: ['hands-on', 'expert-domain'], content: '' },
      { url: 'https://e.com', credibility: 55, independence: 60, tags: ['community'], content: 'hours' },
    ];
    const expected = ['https://a.com', 'https://e.com', 'https://b.com', 'https://c.com', 'https://d.com'];
    eq('topEvidenceForClaim(claim null): same order as before piece 9', topEvidenceForClaim(evidence, 15, null).map((e) => e.url), expected);
    eq('topEvidenceForClaim(claim omitted): same order as before piece 9', topEvidenceForClaim(evidence).map((e) => e.url), expected);
  });

  // Contract 3: claimPassage returns the window that holds the measurement.
  guarded('claimPassage(window)', () => {
    const filler = 'lorem ipsum dolor sit amet consectetur ';
    const needle = 'battery tested at 41.5 hours';
    const head = filler.repeat(400).slice(0, 7000);
    const text = (head + needle + filler.repeat(400)).slice(0, 10000);
    eq('claimPassage fixture: text is 10,000 characters', text.length, 10000);
    eq('claimPassage fixture: "41.5 hours" is near character 7,000', text.indexOf('41.5 hours') > 7000 && text.indexOf('41.5 hours') < 7100, true);

    const passage = callExport('claimPassage', text, ['battery', 'hours'], 1200);
    ok('claimPassage: returns a string', typeof passage === 'string');
    ok('claimPassage: the window contains "41.5 hours"', passage.includes('41.5 hours'));
    ok('claimPassage: the window is at most maxChars long', passage.length <= 1200);
    ok('claimPassage: the window is a slice of the content', text.includes(passage));
  });

  // Contract 4: no term hit gives the first maxChars characters.
  guarded('claimPassage(no hits)', () => {
    const text = 'abcdefghij '.repeat(500);
    eq('claimPassage: no hits returns the first 1,200 characters', callExport('claimPassage', text, ['battery', 'hours'], 1200), text.slice(0, 1200));
    eq('claimPassage: default maxChars is 1,200', callExport('claimPassage', text, ['battery']), text.slice(0, 1200));
    eq('claimPassage: empty terms returns the first maxChars characters', callExport('claimPassage', text, [], 1200), text.slice(0, 1200));
  });

  // Contract 5: claimTerms drops stopwords and keeps numbers and unit tokens.
  guarded('claimTerms', () => {
    const terms = callExport('claimTerms', 'The battery lasts up to 40 hours and is rated IPX4');
    ok('claimTerms: returns an array', Array.isArray(terms));
    ok('claimTerms: keeps "40"', terms.includes('40'));
    ok('claimTerms: keeps "ipx4" in lowercase', terms.includes('ipx4'));
    ok('claimTerms: keeps "battery"', terms.includes('battery'));
    ok('claimTerms: keeps "hours"', terms.includes('hours'));
    for (const stop of ['the', 'up', 'to', 'and', 'is']) {
      eq(`claimTerms: drops the stopword "${stop}"`, terms.includes(stop), false);
    }
    eq('claimTerms: no uppercase token', terms.some((t) => t !== t.toLowerCase()), false);
    eq('claimTerms: tokens are unique', new Set(terms).size, terms.length);

    const many = callExport('claimTerms', 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar battery battery');
    ok('claimTerms: at most 12 terms', many.length <= 12);
    eq('claimTerms: repeated words appear once', many.filter((t) => t === 'battery').length <= 1, true);
  });

  // ── selectSourcesToHydrate ────────────────────────────────────────────────
  {
    const thinA = { url: 'https://a.com', content: 'short snippet' }; // < 800 chars
    const thinB = { url: 'https://b.com', content: 'x'.repeat(100) };
    const thinC = { url: 'https://c.com', content: 'y'.repeat(200) };
    const rich = { url: 'https://d.com', content: 'z'.repeat(2000) }; // >= 800 chars
    const noContent = { url: 'https://e.com' }; // no `content` at all — treated as thin

    eq(
      'selectSourcesToHydrate: picks only the thin sources, in order',
      selectSourcesToHydrate([rich, thinA, thinB]).map((s) => s.url),
      ['https://a.com', 'https://b.com'],
    );

    eq(
      'selectSourcesToHydrate: respects the max cap',
      selectSourcesToHydrate([thinA, thinB, thinC], { max: 2 }).map((s) => s.url),
      ['https://a.com', 'https://b.com'],
    );

    eq('selectSourcesToHydrate: empty input → empty output', selectSourcesToHydrate([]), []);

    eq('selectSourcesToHydrate: all-rich input → empty output', selectSourcesToHydrate([rich]), []);

    eq(
      'selectSourcesToHydrate: a source with no content is treated as thin',
      selectSourcesToHydrate([noContent]).map((s) => s.url),
      ['https://e.com'],
    );

    const input = [thinA, rich, thinB];
    const result = selectSourcesToHydrate(input);
    ok('selectSourcesToHydrate: returns a new array, not the input reference', result !== input);

    eq(
      'selectSourcesToHydrate: a custom thinChars threshold is honored',
      selectSourcesToHydrate([thinC], { thinChars: 100 }).map((s) => s.url),
      [], // thinC is 200 chars, above a 100-char threshold — not thin under that threshold
    );
  }

  // ── stance reply cut off by reasoning tokens ─────────────────────────────
  // Defect: the stance model spends reasoning tokens from max_tokens, so at
  // the old cap (1,500) its JSON was cut off, did not parse, and the claim
  // lost every stance row. These cases guard the cap, the salvage of complete
  // verdicts, one row per url, URL-free passages, and the shared judgeClaim.
  await runStanceCutoffTests(verifyModule, { eq, ok, report });

  // ── 2026-10-07 verify defects (resolve, extract, evidence, stance) ────────
  // One block per defect found in real runs through LiteLLM. Each block is
  // named for the defect it guards.
  await runVerifyDefectTests({ eq, ok, report });

  // ── two-stage claim judge (mimo first, glm on unsubstantiated) ───────────
  await runTwoStageJudgeTests({ eq, ok, report });

  // ── concurrent claim judge (CLAIM_JUDGE_CONCURRENCY at once, order kept) ──
  await runConcurrentJudgeTests({ eq, ok, report });

  // ── reranked claim evidence (ENGINE_CONFIG.evidenceRerank) ───────────────
  await runRerankEvidenceTests({ eq, ok, report });

  return report;
}

// Fake OpenRouter reply in the shape classifyStance reads.
function fakeReply(content, finishReason = 'stop') {
  return { choices: [{ message: { content }, finish_reason: finishReason }], usage: { cost: 0 } };
}

// Exported so the same cases can run against another copy of verify.js.
// Each case catches its own error, so a missing export is one failure.
export async function runStanceCutoffTests(mod, { eq, ok, report }) {
  const label = 'stance reply cut off by reasoning tokens';
  const guarded = async (name, fn) => {
    try { await fn(); } catch (err) {
      report.failed++;
      report.failures.push(`${label}: ${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const call = (name, ...args) => {
    if (typeof mod[name] !== 'function') throw new Error(`worker/engine/verify.js does not export ${name}()`);
    return mod[name](...args);
  };
  const truncated = '```json\n{"verdicts":[{"url":"https://a.com","stance":"support","span":"x"},{"url":"https://b.com","stance":"neu';

  await guarded('parseStanceVerdicts', () => {
    const kept = call('parseStanceVerdicts', truncated);
    eq(`${label}: parseStanceVerdicts keeps the complete verdict of a cut-off reply`, kept.length, 1);
    eq(`${label}: parseStanceVerdicts keeps its url`, kept[0]?.url, 'https://a.com');
    eq(`${label}: parseStanceVerdicts keeps its stance`, kept[0]?.stance, 'support');
    const verdicts = [{ url: 'https://a.com', stance: 'neutral', span: '' }, { url: 'https://b.com', stance: 'support', span: 'y' }];
    eq(`${label}: parseStanceVerdicts on a valid reply equals parsed.verdicts`, call('parseStanceVerdicts', JSON.stringify({ verdicts })), verdicts);
    eq(`${label}: parseStanceVerdicts(null) gives []`, call('parseStanceVerdicts', null), []);
  });

  const claim = { id: 'c1', text: 'Battery lasts up to 40 hours', type: 'spec' };
  const evidence = [
    { url: 'https://a.com', content: 'battery 40 hours', tags: [] },
    { url: 'https://b.com', content: 'battery hours', tags: [] },
    { url: 'https://c.com', content: 'battery', tags: [] },
  ];
  const stanceWith = async (content, finishReason, seen = {}) => call('classifyStance', {
    claim,
    evidence,
    apiKey: 'k',
    model: 'm',
    callLLM: async (_key, _model, _messages, opts) => {
      seen.opts = opts;
      return fakeReply(content, finishReason);
    },
  });

  await guarded('classifyStance cap', async () => {
    const seen = {};
    await stanceWith(JSON.stringify({ verdicts: [] }), 'stop', seen);
    eq(`${label}: classifyStance asks for maxTokens 6000`, seen.opts?.maxTokens, 6000);
  });

  await guarded('classifyStance cut-off reply', async () => {
    const cut = '{"verdicts":[{"url":"https://a.com","stance":"support","span":"s1"},'
      + '{"url":"https://b.com","stance":"contradict","span":"s2"},{"url":"https://c.com","sta';
    const { rows } = await stanceWith(cut, 'length');
    eq(`${label}: classifyStance keeps the 2 complete verdicts of a cut-off reply`, rows.length, 2);
  });

  await guarded('classifyStance repeated url', async () => {
    const twice = JSON.stringify({ verdicts: [
      { url: 'https://a.com', stance: 'support', span: 'first' },
      { url: 'https://a.com', stance: 'contradict', span: 'second' },
    ] });
    const { rows } = await stanceWith(twice, 'stop');
    eq(`${label}: classifyStance gives 1 row for a repeated url`, rows.length, 1);
    eq(`${label}: classifyStance keeps the first stance of a repeated url`, rows[0]?.stance, 'support');
  });

  await guarded('claimPassage', () => {
    const pad = 'lorem ipsum dolor sit amet '.repeat(60);
    const text = `${pad}this press release${pad}Hi-Res audio${pad}`;
    ok(`${label}: claimPassage finds "Hi-Res" for terms hi and res`, call('claimPassage', text, ['hi', 'res'], 200).includes('Hi-Res'));

    const linkText = `${pad}[link](https://x.com/battery-hours-battery-hours)${pad}battery${pad}`;
    const passage = call('claimPassage', linkText, ['battery', 'hours'], 200);
    ok(`${label}: claimPassage ignores hits inside a markdown link URL`, !passage.includes('x.com') && passage.includes('battery'));
  });

  await guarded('judgeClaim', async () => {
    const scored = [
      { url: 'https://lab.example/review', content: 'battery 40 hours measured', credibility: 90, independence: 70, tags: ['hands-on'] },
      { url: 'https://forum.example/t', content: 'battery hours', credibility: 55, independence: 60, tags: ['community'] },
    ];
    const reply = JSON.stringify({ verdicts: [
      { url: 'https://lab.example/review', stance: 'support', span: 'we measured 41 hours' },
      { url: 'https://forum.example/t', stance: 'neutral', span: '' },
    ] });
    const result = await call('judgeClaim', {
      claim, scoredEvidence: scored, apiKey: 'k', model: 'm', callLLM: async () => fakeReply(reply),
    });
    eq(
      `${label}: judgeClaim verdict equals verdictForClaim under the verification policy`,
      result?.verdict,
      verdictForClaim(claim, result?.evidence, { policy: 'verification' }),
    );
  });
}

// ── 2026-10-07 verify defects ───────────────────────────────────────────────
// Real runs through LiteLLM (2026-10-07) found these defects in pipeline order:
// search, resolve, extract, stance call, evidence, judge. Each block is named
// for its defect. The I/O steps run with injected search and read functions
// or a fake fetch, so no block uses the network.

// Calls a module export by name. A missing export throws a clear error, which
// the block records as one failure.
function exportOf(mod, file, name) {
  const fn = mod[name];
  if (typeof fn !== 'function') throw new Error(`${file} does not export ${name}()`);
  return fn;
}
const resolveFn = (name) => exportOf(resolveModule, 'worker/engine/verify-resolve.js', name);
const verifyFn = (name) => exportOf(verifyModule, 'worker/engine/verify.js', name);

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

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// A product page with claims: many distinct spec values and prose lines.
const SPEC_PAGE = [
  'Soundcore Liberty 4 NC True Wireless Earbuds with Adaptive Noise Cancelling',
  'Battery life: up to 10 hours per charge with noise cancelling on, and up to 50 hours with the charging case.',
  'Fast charging: a 5 minute charge gives 4 hours of playtime when you are in a hurry.',
  'Drivers: 11 mm custom drivers with LDAC and Hi-Res Audio Wireless for detailed sound.',
  'Noise cancelling reduces ambient noise by up to 98.5% with six microphones and AI call noise reduction.',
  'Bluetooth 5.3 with multipoint connection to two devices at the same time.',
  'IPX4 water resistance, and each earbud weighs 5.5 g for a comfortable all-day fit.',
].join('\n');

const BATTERY_CLAIM = Object.freeze({ id: 'c1', text: 'Up to 30-hour battery life', type: 'spec' });

export async function runVerifyDefectTests({ eq, ok, report }) {
  const guarded = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      report.failed++;
      report.failures.push(`${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Defect 1: executeSearch read an undefined `tr` (its definition was removed
  // on 2026-08-26), so every web search threw a ReferenceError that runSearch
  // swallowed. The gather got only video results and resolution found no page.
  const d1 = 'web search threw on an undefined tr and returned no results';
  await guarded(d1, async () => {
    const organic = [{ link: 'https://www.jbl.com/FLIP-7.html', title: 'JBL Flip 7', snippet: 'Portable waterproof speaker' }];
    const env = { SERPER_API_KEY: 'test-key' };
    const urls = await withFakeFetch(async () => jsonResponse({ organic }), async () => ({
      recent: (await toolsModule.runSearch('JBL Flip 7', 'web', env, true)).map((s) => s.url),
      evergreen: (await toolsModule.runSearch('JBL Flip 7 specs', 'web', env, false)).map((s) => s.url),
    }));
    eq(`${d1}: a recency-filtered web search returns the results`, urls.recent, ['https://www.jbl.com/FLIP-7.html']);
    eq(`${d1}: an unfiltered web search returns the results`, urls.evergreen, ['https://www.jbl.com/FLIP-7.html']);
  });

  // Defect 2: resolution kept only gathered sources on credibility.js's short
  // maker list, so the maker's own site (soundcore.com, jbl.com) was never a
  // claim page and counted as independent evidence. Resolution now searches
  // for the product's own pages and keeps maker and retailer pages that name it.
  const d2 = "the maker's own site was never a claim page";
  await guarded(d2, async () => {
    const product = 'Anker Soundcore Liberty 4 NC';
    const ownPageKind = resolveFn('ownPageKind');
    eq(`${d2}: a maker subdomain is the maker's page`, ownPageKind('https://us.soundcore.com/products/liberty-4-nc-a3947z11', product), 'maker');
    eq(`${d2}: a retailer on a country domain is a retailer page`, ownPageKind('https://www.amazon.co.uk/dp/B0C6KKQ7ND', product), 'retailer');
    eq(`${d2}: a review site is neither`, ownPageKind('https://www.rtings.com/headphones/reviews/anker/soundcore-liberty-4-nc', product), null);

    const found = [
      { url: 'https://www.rtings.com/headphones/reviews/anker/soundcore-liberty-4-nc', title: 'Anker Soundcore Liberty 4 NC Review' },
      { url: 'https://www.amazon.com/s?k=soundcore+liberty+4+nc', title: 'Amazon.com: soundcore liberty 4 nc' },
      { url: 'https://us.soundcore.com/products/liberty-4-pro-a3954z11', title: 'Soundcore Liberty 4 Pro' },
      { url: 'https://www.amazon.com/dp/B0C6KKQ7ND', title: 'Soundcore Liberty 4 NC Wireless Earbuds' },
      { url: 'https://us.soundcore.com/products/liberty-4-nc-a3947z11', title: 'Soundcore Liberty 4 NC' },
      { url: 'https://us.soundcore.com/products/liberty-4-nc-a3947z11?variant=2', title: 'Soundcore Liberty 4 NC' },
    ];
    const ownPages = ['https://us.soundcore.com/products/liberty-4-nc-a3947z11', 'https://www.amazon.com/dp/B0C6KKQ7ND'];
    eq(
      `${d2}: candidates are the maker page, then the retailer page (no review, listing, other model, or second copy)`,
      resolveFn('rankClaimCandidates')(found, product).map((c) => c.url),
      ownPages,
    );

    const searched = [];
    const resolved = await verifyFn('resolveClaimSources')({
      product,
      env: {},
      search: async (query) => {
        searched.push(query);
        return found;
      },
      read: async (source) => Object.assign(source, { content: SPEC_PAGE }),
      focusedRead: async () => '',
    });
    ok(`${d2}: resolution searches for the product's own pages`, searched.includes(product));
    eq(`${d2}: resolution reads the maker page and the retailer page`, resolved.claimSources.map((c) => c.url), ownPages);
  });

  // Defect 3: a keyless read of a product page can return a bot wall, or only
  // the site's menus (electronics.sony.com: the menus fill the reader's
  // 15,000-char cap). Extraction got that text and found 0 claims.
  const d3 = 'a bot wall or a menu-only read was used as the claim page';
  await guarded(d3, async () => {
    const claimPageProblem = resolveFn('claimPageProblem');
    const menus = Array.from({ length: 900 }, (_, i) => `[Menu item ${i}](https://www.sony.com/m/${i})`).join('\n');
    const wall = `Pardon Our Interruption\n${'As you were browsing something about your browser made us think you were a bot. '.repeat(8)}`;
    eq(`${d3}: menu-only text has no claim content`, claimPageProblem(menus), 'no-claim-content');
    eq(`${d3}: a bot wall is a block page`, claimPageProblem(wall), 'block-page');
    eq(`${d3}: a spec page is usable`, claimPageProblem(SPEC_PAGE), null);

    const candidates = [
      { url: 'https://electronics.sony.com/audio/headphones/headband/p/wh1000xm6-b', title: 'WH-1000XM6', content: '' },
      { url: 'https://www.walmart.com/ip/sony-wh-1000xm6/123', title: 'Sony WH-1000XM6', content: '' },
    ];
    const result = await resolveFn('readClaimPages')(candidates, {}, {
      wanted: 2,
      maxReads: 4,
      read: async (source) => Object.assign(source, { content: source.url.includes('sony.com') ? menus : wall }),
      focusedRead: async (url) => (url.includes('sony.com') ? SPEC_PAGE : ''),
    });
    eq(`${d3}: the focused read replaces a menu-only read`, result.pages.map((p) => p.content === SPEC_PAGE), [true]);
    eq(`${d3}: a page that stays a bot wall is rejected with its reason`, result.rejected.map((r) => r.reason), ['block-page']);
    eq(`${d3}: the candidates do not change`, candidates.map((c) => c.content), ['', '']);
  });

  // Defect 4: the extraction input gave the first page the whole 20,000-char
  // budget, raw markdown included (image and link targets), so a second page
  // never reached the model. A thin first pass now reads more candidates.
  const d4 = 'the first claim page took the whole extraction budget';
  await guarded(d4, async () => {
    eq(`${d4}: fairShares keeps a short text whole and splits the rest`, verifyFn('fairShares')([100, 50_000, 50_000], 20_000), [100, 9950, 9950]);
    const long = `![hero](https://cdn.example/hero.png)\n${'Battery life up to 50 hours with the case and 10 hours per charge. '.repeat(600)}`;
    const block = verifyFn('buildClaimTextBlock')([
      { url: 'https://www.soundcore.com/products/a', title: 'Maker page', content: long },
      { url: 'https://www.amazon.com/dp/B0', title: 'Retailer page', content: 'Weight 5.5 g per earbud. Bluetooth 5.3.' },
    ]);
    ok(`${d4}: the second page reaches the extraction input`, block.includes('Weight 5.5 g per earbud'));
    ok(`${d4}: image targets are not sent`, !block.includes('cdn.example'));
    ok(`${d4}: the input stays inside the budget`, block.length <= 20_500);

    const first = { url: 'https://www.soundcore.com/products/a', title: 'A', content: SPEC_PAGE };
    const second = { url: 'https://www.amazon.com/dp/B0', title: 'B', content: '' };
    const replies = [
      { claims: [{ text: 'Up to 10 hours per charge', type: 'spec' }] },
      { claims: ['10 hours per charge', '50 hours with the case', 'IPX4 water resistance', 'Bluetooth 5.3'].map((text) => ({ text, type: 'spec' })) },
    ];
    const extracted = await verifyFn('extractProductClaims')({
      product: 'Anker Soundcore Liberty 4 NC',
      resolved: { claimSources: [first], candidates: [first, second], nextIndex: 1, readsLeft: 2 },
      env: {},
      apiKey: 'k',
      model: 'm',
      callLLM: async () => fakeReply(JSON.stringify(replies.shift())),
      read: async (source) => Object.assign(source, { content: SPEC_PAGE }),
      focusedRead: async () => '',
    });
    eq(`${d4}: a thin first pass reads one more page and keeps the larger claim set`, extracted.claims.length, 4);
    eq(`${d4}: the retry pass extracts from both pages`, extracted.claimSources.map((c) => c.url), [first.url, second.url]);
  });

  // Defect 5: LiteLLM serves the stance model as claude-sonnet-5, which takes
  // only its default temperature. Every stance call got HTTP 400, so no claim
  // got a stance. The call now goes once more without temperature.
  const d5 = 'stance calls failed because the model rejects temperature 0';
  await guarded(d5, async () => {
    const bodies = [];
    const rejectTemperature = async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if ('temperature' in body) {
        const message = 'litellm.UnsupportedParamsError: claude-sonnet-5 does not support temperature=0. Only temperature=1 is supported.';
        return jsonResponse({ error: { message } }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: '{"verdicts":[]}' }, finish_reason: 'stop' }], usage: {} });
    };
    const messages = [{ role: 'user', content: 'hi' }];
    const resp = await withFakeFetch(rejectTemperature, () => llmModule.callLLM('test-key', 'minimax/minimax-m3', messages, {}));
    eq(`${d5}: the call returns the model reply`, resp?.choices?.[0]?.message?.content, '{"verdicts":[]}');
    eq(`${d5}: the first request sends temperature 0`, bodies[0]?.temperature, 0);
    eq(`${d5}: the second request leaves temperature out`, bodies.length === 2 && !('temperature' in bodies[1]), true);

    let calls = 0;
    const otherBadRequest = async () => {
      calls += 1;
      return jsonResponse({ error: { message: 'max_tokens is too large' } }, 400);
    };
    const threw = await withFakeFetch(otherBadRequest, () => llmModule.callLLM('test-key', 'minimax/minimax-m3', messages, {}))
      .then(() => false, () => true);
    eq(`${d5}: another HTTP 400 is not sent again`, { threw, calls }, { threw: true, calls: 1 });
  });

  // Defect 6: stance evidence was ranked by claim-term hits over the whole page
  // (a long page hits most terms by chance), with the product name's words as
  // claim terms. Spec echoes and roundups filled the top 15, and the passage
  // with the measurement was not sent. The pool also held the maker's and the
  // retailers' pages and reviews of other models.
  const d6 = 'measured test passages did not reach the stance evidence';
  await guarded(d6, async () => {
    const product = 'Sony WH-1000XM6 headphones';
    eq(
      `${d6}: the product name and filler verbs are not claim terms`,
      verifyFn('claimTermsFor')('Sony WH-1000XM6 offers up to 30-hour battery life', product),
      ['30', 'hour', 'battery', 'life'],
    );

    const filler = 'The headphones come in black, silver, and midnight blue, with a hard carrying case. '.repeat(30);
    const page = `Specs: battery life 30 hours.\n${filler}\nBattery life: in our battery test the WH-1000XM6 lasted 37 hours.\n${filler}`;
    const window = verifyFn('claimEvidencePassage')(page, ['30', 'hour', 'battery', 'life']);
    ok(`${d6}: the passage with the measurement is chosen over the spec row`, window.passage.includes('lasted 37 hours') && window.testLanguage);

    const weight = { credibility: 65, independence: 60, tags: [] };
    const echo = { ...weight, url: 'https://deals.example/sony-wh-1000xm6-deal', title: 'Sony WH-1000XM6 deal', content: 'Sony rates the WH-1000XM6 for 30 hours of battery life.' };
    const lab = { ...weight, url: 'https://lab.example/sony-wh-1000xm6-review', title: 'Sony WH-1000XM6 review', content: 'Battery life: in our battery test the WH-1000XM6 lasted 37 hours.' };
    const roundup = {
      ...weight,
      credibility: 90,
      url: 'https://news.example/best-noise-cancelling-headphones',
      title: 'Best noise cancelling headphones',
      content: `Sony WH-1000XM6: our top pick.\n${'x '.repeat(1000)}\nBattery life: in our battery test the Bose QuietComfort Ultra lasted 24 hours.`,
    };
    const ranked = verifyFn('rankClaimEvidence')([roundup, echo, lab], BATTERY_CLAIM, product, 15).map((s) => s.url);
    eq(`${d6}: the measured test ranks first`, ranked[0], lab.url);
    ok(`${d6}: a roundup passage about another product ranks below the test of this product`, ranked.indexOf(roundup.url) > ranked.indexOf(lab.url));

    const pasted = 'https://pasted.example/wh-1000xm6';
    const fullPage = `In our battery test the WH-1000XM6 lasted 37 hours. ${'More test notes. '.repeat(100)}`;
    const pool = verifyFn('evidencePool')([
      { url: 'https://electronics.sony.com/p/wh1000xm6-b', title: 'WH-1000XM6', content: 'Sony WH-1000XM6' },
      { url: 'https://www.bestbuy.com/site/sony-wh1000xm6/123.p', title: 'Sony WH-1000XM6', content: 'Sony WH-1000XM6' },
      { url: 'https://www.soundguys.com/sony-wf-1000xm6-review-152013/', title: 'Sony WF-1000XM6 review', content: 'The WF-1000XM6 earbuds' },
      { url: 'https://lab.example/sony-wh-1000xm6-review', title: 'Sony WH-1000XM6 review', content: 'a search snippet' },
      { url: 'https://lab.example/sony-wh-1000xm6-review/', title: 'Sony WH-1000XM6 review', content: fullPage },
      { url: pasted, title: 'Sony WH-1000XM6', content: 'Sony WH-1000XM6' },
    ], product, pasted);
    eq(
      `${d6}: the pool keeps one copy of each independent page about this model, the full page over its snippet`,
      pool.map((s) => [s.url, s.content]),
      [['https://lab.example/sony-wh-1000xm6-review/', fullPage]],
    );
  });

  // Defect 8: the evidence was the gather's results only: generic searches,
  // and about 1 in 15 sources read (the keyless reader answers most of the
  // gather's read burst with HTTP 429). The pool held 150-char snippets, so a
  // claim's test result never reached the judge. Each claim now gets its own
  // search, and the best snippet-only test pages get a full read.
  const d8 = 'the stance evidence was search snippets without test results';
  await guarded(d8, async () => {
    const product = 'Anker Soundcore Liberty 4 NC';
    eq(
      `${d8}: a claim search names the product and the claim topic, without bare numbers`,
      resolveFn('claimSearchQuery')(product, ['10', 'hours', 'playtime']),
      'Anker Soundcore Liberty 4 NC hours playtime review test',
    );

    const merged = resolveFn('uniqueEvidence')([
      { url: 'https://lab.example/liberty-4-nc', content: 'They last 8.6 hours.' },
      { url: 'https://lab.example/liberty-4-nc/', content: 'Noise isolation is good.' },
    ]);
    eq(`${d8}: two snippets of one page join`, merged.map((s) => s.content), ['They last 8.6 hours.\nNoise isolation is good.']);

    const results = {
      'battery': [
        { url: 'https://www.youtube.com/watch?v=abc', title: 'Soundcore Liberty 4 NC review', content: 'video' },
        { url: 'https://www.amazon.com/dp/B0C6KKQ7ND', title: 'Soundcore Liberty 4 NC', content: 'listing' },
        { url: 'https://www.rtings.com/headphones/reviews/anker/soundcore-liberty-4-nc', title: 'Anker Soundcore Liberty 4 NC Review', content: 'They last 8.6 hours.' },
      ],
      'ipx4': [
        { url: 'https://www.soundguys.com/liberty-4-nc-vs-liberty-4-pro', title: 'Soundcore Liberty 4 NC vs Liberty 4 Pro', content: 'IPX4 on both.' },
        { url: 'https://www.rtings.com/headphones/reviews/anker/soundcore-liberty-4-nc', title: 'Anker Soundcore Liberty 4 NC Review', content: 'Not rated for water.' },
        { url: 'https://www.techradar.com/audio/earbuds/soundcore-liberty-4-nc-review', title: 'Soundcore Liberty 4 NC review', content: 'Fine in rain.' },
      ],
    };
    const claims = [
      { id: 'c1', text: 'Up to 10 hours of battery life', type: 'spec' },
      { id: 'c2', text: 'IPX4 water resistance', type: 'spec' },
    ];
    const queries = [];
    const reads = [];
    const tests = await verifyFn('findClaimTests')({
      claims,
      product,
      env: {},
      search: async (query) => {
        queries.push(query);
        return query.includes('battery') ? results.battery : results.ipx4;
      },
      read: async (source) => {
        reads.push(source.url);
        return Object.assign(source, { content: `In our testing the Liberty 4 NC lasted 8.6 hours. ${'Test notes. '.repeat(200)}` });
      },
    });
    eq(`${d8}: one search per claim`, queries.length, 2);
    eq(
      `${d8}: review pages that name the product are read first, then other pages that name it; no video or retailer page`,
      reads,
      [
        'https://www.rtings.com/headphones/reviews/anker/soundcore-liberty-4-nc',
        'https://www.techradar.com/audio/earbuds/soundcore-liberty-4-nc-review',
        'https://www.soundguys.com/liberty-4-nc-vs-liberty-4-pro',
      ],
    );
    eq(`${d8}: every read gave page text`, tests.filled, 3);
    const pool = verifyFn('evidencePool')(tests.sources, product, null);
    const rtings = pool.find((s) => s.url.includes('rtings.com'));
    ok(`${d8}: the pool keeps the full read of a page`, String(rtings?.content ?? '').startsWith('In our testing the Liberty 4 NC lasted 8.6 hours.'));
    eq(`${d8}: the search results do not change`, results.battery[2].content, 'They last 8.6 hours.');
  });

  // Defect 7: the judge counted a deal post's different spec value as a
  // contradiction and a review of another model (the WF-1000XM6 earbuds) as
  // support. It was never told which product the claim is about.
  const d7 = 'the stance judge decided claims from deal posts and other models';
  await guarded(d7, async () => {
    const system = String(verifyModule.STANCE_SYSTEM ?? '');
    ok(`${d7}: a contradiction needs the source's own testing`, /contradict ONLY if the source's own testing/.test(system));
    ok(`${d7}: a source about a different product is neutral`, /about a different product/.test(system));
    let sent = null;
    await verifyFn('classifyStance')({
      claim: BATTERY_CLAIM,
      evidence: [{ url: 'https://lab.example/r', title: 'Sony WH-1000XM6 review', content: 'lasted 37 hours', passage: 'In our battery life test it lasted 37 hours.' }],
      apiKey: 'k',
      model: 'm',
      product: 'Sony WH-1000XM6 headphones',
      callLLM: async (_key, _model, messages) => {
        sent = messages;
        return fakeReply('{"verdicts":[]}');
      },
    });
    const user = String(sent?.[1]?.content ?? '');
    ok(`${d7}: the judge is told the product`, user.startsWith('Product: "Sony WH-1000XM6 headphones"'));
    ok(`${d7}: the judge sees the page title and the claim passage`, user.includes('(Sony WH-1000XM6 review)\nIn our battery life test it lasted 37 hours.'));
  });

  // Defect 9: the judge called "30 mm" a contradiction of "1.18 in", and a
  // practical speed a contradiction of an "up to" maximum.
  const d9 = 'the stance judge contradicted claims the source agreed with';
  await guarded(d9, async () => {
    const system = String(verifyModule.STANCE_SYSTEM ?? '');
    ok(`${d9}: units are converted before a compare`, /Convert units before you compare \(mm\/in, g\/oz, W, mAh, dB, Hz, %\)/.test(system));
    ok(`${d9}: a value within about 3% agrees`, /within normal measurement tolerance \(about 3%\)/.test(system));
    ok(`${d9}: a typical figure does not contradict an "up to" maximum`, /does not contradict a stated maximum or peak \("up to"\)/.test(system));
    ok(`${d9}: a contradiction needs a measurement of the same quantity`, /own measurement of the same quantity disagrees/.test(system));
  });

  // Defect 10 (2026-10-08): the name match required generic qualifier words
  // ("12th", "mouse"), so retailer pages for "Kindle Paperwhite 12th
  // generation" and the maker page for "Logitech G Pro X Superlight 2 mouse"
  // were other-product, and the check ended needs_input.
  const d10 = 'generic qualifier words made the right product page other-product';
  await guarded(d10, async () => {
    const reason = (url, product, title = '') => resolveFn('claimCandidateReason')({ url, title }, product);
    const kindle = 'Kindle Paperwhite 12th generation';
    eq(`${d10}: the Best Buy Paperwhite page matches`, reason('https://www.bestbuy.com/product/amazon-kindle-paperwhite-16-gb-2024-black/J39HW6QL86', kindle), 'retailer');
    eq(`${d10}: the Target Paperwhite page matches`, reason('https://www.target.com/p/amazon-kindle-paperwhite-2024-black/-/A-91563138', kindle), 'retailer');
    eq(`${d10}: a Kindle Scribe page does not match`, reason('https://www.bestbuy.com/product/amazon-kindle-scribe-16-gb-2024-tungsten/J39HW7XYZ1', kindle), 'other-product');
    eq(`${d10}: an Amazon category landing page stays excluded`, reason('https://www.amazon.com/clp/B0CFPJYX7P', kindle, 'Kindle Paperwhite'), 'listing-page');
    eq(`${d10}: a Paperwhite Signature name does not match a plain Paperwhite page`, reason('https://www.target.com/p/amazon-kindle-paperwhite-2024-black/-/A-91563138', 'Kindle Paperwhite Signature Edition'), 'other-product');

    const mouse = 'Logitech G Pro X Superlight 2 mouse';
    eq(`${d10}: the Superlight 2 page matches`, reason('https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-2.910-006628.html', mouse), 'maker');
    eq(`${d10}: the first Superlight page does not match`, reason('https://www.logitechg.com/en-us/products/gaming-mice/pro-x-superlight-wireless-mouse.910-005878.html', mouse), 'other-product');
    ok(`${d10}: a Superlight 1 page names another model`, resolveFn('namesOtherModel')({ url: 'https://example.com/pro-x-superlight-1-review' }, mouse));
  });
}

// ── two-stage claim judge ───────────────────────────────────────────────────
// judgeClaim runs the fallback model only when the primary verdict is
// unsubstantiated, and uses its verdict only when it is decided.
async function runTwoStageJudgeTests({ eq, ok, report }) {
  const label = 'two-stage claim judge';
  const guarded = async (name, fn) => {
    try { await fn(); } catch (err) {
      report.failed++;
      report.failures.push(`${label}: ${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const claim = { id: 'c9', text: 'Battery lasts up to 40 hours', type: 'spec' };
  const scored = [
    { url: 'https://lab.example/review', content: 'battery 40 hours measured', credibility: 90, independence: 70, tags: ['hands-on'] },
    { url: 'https://forum.example/t', content: 'battery hours measured', credibility: 80, independence: 70, tags: ['hands-on'] },
  ];
  const decided = JSON.stringify({ verdicts: [
    { url: 'https://lab.example/review', stance: 'contradict', span: 'we measured only 20 hours' },
    { url: 'https://forum.example/t', stance: 'contradict', span: 'our test ran out at 21 hours' },
  ] });
  const undecided = JSON.stringify({ verdicts: [
    { url: 'https://lab.example/review', stance: 'neutral', span: '' },
    { url: 'https://forum.example/t', stance: 'neutral', span: '' },
  ] });
  // Fake callLLM: replies per model, records each call's model and maxTokens.
  const fakeLLM = (replies) => {
    const calls = [];
    const fn = async (_key, model, _messages, opts) => {
      calls.push({ model, maxTokens: opts?.maxTokens });
      const reply = replies[model];
      if (reply instanceof Error) throw reply;
      return fakeReply(reply);
    };
    return { fn, calls };
  };
  const judge = (llm, extra = {}) => verifyFn('judgeClaim')({
    claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: 'fallback', callLLM: llm.fn, ...extra,
  });

  await guarded('primary decided', async () => {
    const llm = fakeLLM({ primary: decided, fallback: decided });
    const result = await judge(llm);
    eq(`${label}: a decided primary verdict makes one call`, llm.calls.map((c) => c.model), ['primary']);
    eq(`${label}: a decided primary verdict is kept`, result?.verdict?.status, 'contradicted');
    eq(`${label}: judgeModel is the primary`, result?.judgeModel, 'primary');
  });

  await guarded('fallback decided', async () => {
    const llm = fakeLLM({ primary: undecided, fallback: decided });
    const result = await judge(llm);
    eq(`${label}: an unsubstantiated primary runs the fallback once`, llm.calls.map((c) => c.model), ['primary', 'fallback']);
    eq(`${label}: a decided fallback verdict is used`, result?.verdict?.status, 'contradicted');
    eq(`${label}: judgeModel is the fallback`, result?.judgeModel, 'fallback');
    ok(`${label}: the fallback token budget is at least the primary's`, llm.calls[1].maxTokens >= llm.calls[0].maxTokens);
    eq(
      `${label}: the fallback verdict follows the verification policy`,
      result?.verdict,
      verdictForClaim(claim, result?.evidence, { policy: 'verification' }),
    );
  });

  await guarded('fallback unsubstantiated', async () => {
    const llm = fakeLLM({ primary: undecided, fallback: undecided });
    const result = await judge(llm);
    eq(`${label}: an unsubstantiated fallback runs once`, llm.calls.length, 2);
    eq(`${label}: an unsubstantiated fallback keeps the primary verdict`, result?.verdict?.status, 'unsubstantiated');
    eq(`${label}: judgeModel stays the primary`, result?.judgeModel, 'primary');
  });

  await guarded('fallback throws', async () => {
    const llm = fakeLLM({ primary: undecided, fallback: new Error('upstream timeout') });
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    let result;
    try { result = await judge(llm); } finally { console.warn = realWarn; }
    eq(`${label}: a fallback error keeps the primary verdict`, result?.verdict?.status, 'unsubstantiated');
    eq(`${label}: a fallback error keeps judgeModel as the primary`, result?.judgeModel, 'primary');
    eq(`${label}: a fallback error logs one warning`, warnings.length, 1);
    ok(`${label}: the warning names the claim id`, warnings[0]?.includes('c9'));
    ok(`${label}: the warning has no claim text`, !warnings[0]?.includes(claim.text));
  });

  await guarded('no fallback model', async () => {
    const llm = fakeLLM({ primary: undecided });
    const result = await judge(llm, { fallbackModel: undefined });
    eq(`${label}: no fallback model makes one call`, llm.calls.length, 1);
    eq(`${label}: no fallback model keeps the primary verdict`, result?.verdict?.status, 'unsubstantiated');
  });

  await guarded('fallback same as primary', async () => {
    const llm = fakeLLM({ primary: undecided });
    await judge(llm, { fallbackModel: 'primary' });
    eq(`${label}: a fallback equal to the primary makes one call`, llm.calls.length, 1);
  });
}

// ── concurrent claim judge ──────────────────────────────────────────────────
// judgeClaims runs judgeClaim for every claim with bounded concurrency. The
// results must equal the one-at-a-time path, in claim order.
async function runConcurrentJudgeTests({ eq, ok, report }) {
  const label = 'concurrent claim judge';
  const guarded = async (name, fn) => {
    try { await fn(); } catch (err) {
      report.failed++;
      report.failures.push(`${label}: ${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const DELAY_MS = 40;
  const claims = Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, text: `Battery lasts ${10 + i} hours`, type: 'spec' }));
  const scored = [
    { url: 'https://lab.example/review', content: 'battery hours measured', credibility: 90, independence: 70, tags: ['hands-on'] },
    { url: 'https://forum.example/t', content: 'battery hours measured', credibility: 80, independence: 70, tags: ['hands-on'] },
  ];
  // Each claim gets its own reply (and cost), picked from the claim text.
  const replyFor = (messages) => {
    const n = Number(/Battery lasts (\d+) hours/.exec(String(messages?.[1]?.content ?? ''))?.[1] ?? 0);
    const stance = n % 2 === 0 ? 'contradict' : 'support';
    const reply = fakeReply(JSON.stringify({ verdicts: [
      { url: 'https://lab.example/review', stance, span: `in our test we measured ${n} hours` },
      { url: 'https://forum.example/t', stance, span: `our battery test ran ${n} hours` },
    ] }));
    return { ...reply, usage: { cost: n / 1000 } };
  };
  // Fake callLLM: resolves after DELAY_MS, records the peak in-flight count.
  // Silences console.warn while fn runs, keeps the lines for assertions.
  const captureWarn = async (fn) => {
    const original = console.warn;
    const lines = [];
    console.warn = (...a) => { lines.push(a.join(' ')); };
    try { return { value: await fn(), lines }; } finally { console.warn = original; }
  };
  const abortError = () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
  };
  const delayedLLM = ({ failText, failWith = () => new Error('upstream 502') } = {}) => {
    const state = { inFlight: 0, maxInFlight: 0, calls: 0 };
    const fn = async (_key, _model, messages) => {
      state.calls++;
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        const prompt = String(messages?.[1]?.content ?? '');
        if (failText && (failText === '*' || prompt.includes(failText))) throw failWith();
        return replyFor(messages);
      } finally {
        state.inFlight--;
      }
    };
    return { fn, state };
  };
  const config = { stanceModel: 'primary' };
  const args = (callLLM) => ({ claims, scoredEvidence: scored, config, apiKey: 'k', callLLM, product: 'Acme Buds' });

  await guarded('bounded concurrency', async () => {
    eq(`${label}: CLAIM_JUDGE_CONCURRENCY is 12`, verifyModule.CLAIM_JUDGE_CONCURRENCY, 12);
    const llm = delayedLLM();
    const started = Date.now();
    // The bound is checked with an explicit concurrency of 4 (8 claims, 2 batches).
    const results = await verifyFn('judgeClaims')({ ...args(llm.fn), concurrency: 4 });
    const elapsed = Date.now() - started;
    eq(`${label}: max in-flight is 4`, llm.state.maxInFlight, 4);
    eq(`${label}: one call per claim`, llm.state.calls, 8);
    ok(`${label}: 8 claims take about 2 delays, not 8 (${elapsed} ms)`, elapsed < DELAY_MS * 4);
    eq(
      `${label}: results keep the claim order`,
      results.map((r) => r?.costUsd),
      claims.map((_, i) => (10 + i) / 1000),
    );
  });

  await guarded('equals the sequential path', async () => {
    const sequential = [];
    for (const claim of claims) {
      sequential.push(await verifyFn('judgeClaim')({
        claim, scoredEvidence: scored, apiKey: 'k', model: 'primary', fallbackModel: undefined,
        callLLM: delayedLLM().fn, product: 'Acme Buds',
      }));
    }
    const concurrent = await verifyFn('judgeClaims')(args(delayedLLM().fn));
    eq(`${label}: results deep-equal the sequential path`, concurrent, sequential);
  });

  // CHANGED 2026-10-08: a single failing claim no longer fails the run. Its
  // slot is the no-evidence unsubstantiated verdict. All claims failing still
  // fails the run with the first error.
  const noEvidenceVerdict = (claim) => verdictForClaim(claim, [], verifyModule.VERDICT_OPTS);

  await guarded('one claim error', async () => {
    const llm = delayedLLM({ failText: 'Battery lasts 12 hours' });
    const { value: results, lines } = await captureWarn(() => verifyFn('judgeClaims')(args(llm.fn)));
    eq(`${label}: one result slot per claim`, results.length, 8);
    eq(`${label}: the failed claim gets the no-evidence verdict`, results[2]?.verdict, noEvidenceVerdict(claims[2]));
    eq(`${label}: the failed claim verdict is unsubstantiated`, results[2]?.verdict?.status, 'unsubstantiated');
    eq(`${label}: the failed claim has no evidence rows`, results[2]?.evidence, []);
    eq(`${label}: the failed claim has no judge model`, results[2]?.judgeModel, null);
    eq(`${label}: the failed claim costs 0`, results[2]?.costUsd, 0);
    ok(
      `${label}: the other claims are judged`,
      results.every((r, i) => i === 2 || (r?.verdict && typeof r.verdict.status === 'string' && r.error === undefined)),
    );
    eq(`${label}: one warning for the failed claim`, lines.length, 1);
    ok(`${label}: the warning names the claim id and the error`, /claim c2\b/.test(lines[0] ?? '') && (lines[0] ?? '').includes('upstream 502'));
    ok(`${label}: the warning has no prompt text`, !(lines[0] ?? '').includes('Battery lasts'));
  });

  await guarded('one claim AbortError, run completes', async () => {
    const llm = delayedLLM({ failText: 'Battery lasts 15 hours', failWith: abortError });
    const { value: results } = await captureWarn(() => verifyFn('judgeClaims')(args(llm.fn)));
    const { claimVerdicts, costUsd } = verifyFn('collectClaimVerdicts')(claims, results);
    eq(`${label}: abort: every claim has a verdict`, claimVerdicts.length, 8);
    eq(`${label}: abort: the aborted claim is unsubstantiated`, claimVerdicts[5].status, 'unsubstantiated');
    eq(`${label}: abort: the aborted claim has no supporting rows`, claimVerdicts[5].supporting, noEvidenceVerdict(claims[5]).supporting);
    eq(`${label}: abort: the aborted claim has no judge model`, claimVerdicts[5].judgeModel, null);
    ok(`${label}: abort: the error is not copied into the claim`, !('error' in claimVerdicts[5]));
    ok(
      `${label}: abort: the other claims are judged by the primary model`,
      claimVerdicts.every((c, i) => i === 5 || c.judgeModel === 'primary'),
    );
    const expectedCost = claims.reduce((sum, _, i) => sum + (i === 5 ? 0 : (10 + i) / 1000), 0);
    ok(`${label}: abort: cost sums the judged claims`, Math.abs(costUsd - expectedCost) < 1e-9);
  });

  await guarded('every claim fails', async () => {
    const llm = delayedLLM({ failText: '*', failWith: abortError });
    const { value: results, lines } = await captureWarn(() => verifyFn('judgeClaims')(args(llm.fn)));
    eq(`${label}: all fail: one warning per claim`, lines.length, 8);
    let thrown = null;
    try { verifyFn('collectClaimVerdicts')(claims, results); } catch (err) { thrown = err; }
    ok(`${label}: all fail: the run fails with the first error`, thrown === results[0].error && thrown?.name === 'AbortError');
  });

  await guarded('no claims', async () => {
    const out = verifyFn('collectClaimVerdicts')([], []);
    eq(`${label}: no claims: no verdicts and no cost`, out, { claimVerdicts: [], costUsd: 0 });
  });
}

// ── reranked claim evidence ─────────────────────────────────────────────────
// ENGINE_CONFIG.evidenceRerank: off (the default) keeps today's selection and
// makes no rerank call. On, the judge's passages follow the rerank scores. A
// rerank error falls back to today's selection.
const RERANK_PRODUCT = 'Acme Buds Pro';
const RERANK_CLAIM = Object.freeze({ id: 'c3', text: 'Battery lasts up to 30 hours', type: 'spec' });
const RERANK_POOL = Object.freeze([
  {
    url: 'https://lab.example/acme-buds-pro-review',
    title: 'Acme Buds Pro review',
    content: `Acme Buds Pro review. The battery is rated for 30 hours. ${'The case is small and the hinge feels solid in the hand. '.repeat(25)}\n`
      + 'In our battery test the Acme Buds Pro lasted 27 hours of playback at 50% volume before they shut off.',
    credibility: 90, independence: 80, tags: ['hands-on'],
  },
  {
    url: 'https://forum.example/acme-buds-pro',
    title: 'Acme Buds Pro owners thread',
    content: 'Acme Buds Pro owners thread. Mine get about 30 hours of battery with the case on a long trip, close to the box claim.',
    credibility: 70, independence: 80, tags: ['hands-on'],
  },
  {
    url: 'https://news.example/acme-buds-pro-launch',
    title: 'Acme Buds Pro launch news',
    content: 'Acme Buds Pro launch news. Acme announced the Buds Pro today with a 30 hours battery claim and a new blue color.',
    credibility: 60, independence: 60, tags: [],
  },
]);

// A fake rerank endpoint: scores each document with scoreOf(text), records each request body.
function fakeRerankFetch(scoreOf, status = 200) {
  const bodies = [];
  const fn = async (url, init) => {
    if (!String(url).startsWith('https://api.jina.ai/v1/rerank')) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (status !== 200) return new Response('{"detail":"upstream error"}', { status });
    const results = body.documents.map((d, index) => ({ index, relevance_score: scoreOf(d) }));
    return jsonResponse({ model: body.model, usage: { total_tokens: 42 }, results });
  };
  return { fn, bodies };
}

async function runRerankEvidenceTests({ eq, ok, report }) {
  const label = 'reranked claim evidence';
  const guarded = async (name, fn) => {
    try { await fn(); } catch (err) {
      report.failed++;
      report.failures.push(`${label}: ${name}: threw ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const pick = (rerank) => verifyFn('pickClaimEvidence')({ claim: RERANK_CLAIM, scoredEvidence: RERANK_POOL, product: RERANK_PRODUCT, rerank });
  const today = () => verifyFn('rankClaimEvidence')(RERANK_POOL, RERANK_CLAIM, RERANK_PRODUCT, 15);
  const quietWarn = async (fn) => {
    const warnings = [];
    const real = console.warn;
    console.warn = (...args) => { warnings.push(args.join(' ')); };
    try { return { value: await fn(), warnings }; } finally { console.warn = real; }
  };

  await guarded('rerankOptions', async () => {
    const opts = verifyFn('rerankOptions');
    eq(`${label}: flag off gives no rerank options`, opts({ evidenceRerank: false }, { JINA_API_KEY: 'jk' }), null);
    eq(`${label}: flag on without a key gives no rerank options`, opts({ evidenceRerank: true }, {}), null);
    eq(`${label}: flag on with a key gives the key and model`, opts({ evidenceRerank: true, rerankModel: 'm1' }, { JINA_API_KEY: 'jk' }), { apiKey: 'jk', model: 'm1' });
  });

  await guarded('flag off', async () => {
    const fake = fakeRerankFetch(() => 1);
    const picked = await withFakeFetch(fake.fn, () => pick(null));
    eq(`${label}: flag off keeps today's selection`, picked, today());

    const llmCalls = [];
    const llm = async (_k, _m, messages) => { llmCalls.push(messages); return fakeReply('{"verdicts":[]}'); };
    await withFakeFetch(fake.fn, () => verifyFn('judgeClaims')({
      claims: [RERANK_CLAIM], scoredEvidence: RERANK_POOL, config: { stanceModel: 'm', evidenceRerank: false },
      apiKey: 'k', callLLM: llm, product: RERANK_PRODUCT, env: { JINA_API_KEY: 'jk' },
    }));
    eq(`${label}: flag off makes no rerank call`, fake.bodies.length, 0);
    eq(`${label}: flag off still judges the claim`, llmCalls.length, 1);
  });

  await guarded('flag on orders passages by rerank score', async () => {
    // The measurement passage scores highest, then the forum, then the launch news.
    const scoreOf = (d) => (d.includes('In our battery test') ? 0.9 : d.includes('owners thread') ? 0.5 : d.includes('launch news') ? 0.1 : -0.5);
    const fake = fakeRerankFetch(scoreOf);
    const usage = [];
    const picked = await pick({ apiKey: 'jk', model: 'jina-reranker-v3.5', fetchImpl: fake.fn, onUsage: (u) => usage.push(u) });
    eq(`${label}: one rerank call per claim`, fake.bodies.length, 1);
    eq(`${label}: the query is the claim text`, fake.bodies[0]?.query, RERANK_CLAIM.text);
    eq(`${label}: sources follow the rerank order`, picked.map((s) => s.url), [RERANK_POOL[0].url, RERANK_POOL[1].url, RERANK_POOL[2].url]);
    ok(
      `${label}: the top source carries its best-scored passage, not its first`,
      picked[0]?.passage?.includes('In our battery test') && !picked[0]?.passage?.startsWith('Acme Buds Pro review'),
    );
    ok(`${label}: rows keep the source fields`, picked.every((s) => typeof s.credibility === 'number' && Array.isArray(s.tags) && typeof s.content === 'string'));
    eq(`${label}: onUsage gets the token count`, usage[0]?.totalTokens, 42);

    const reversed = fakeRerankFetch((d) => (d.includes('launch news') ? 0.9 : d.includes('owners thread') ? 0.5 : 0.1));
    const flipped = await pick({ apiKey: 'jk', fetchImpl: reversed.fn });
    eq(`${label}: other scores give another source order`, flipped.map((s) => s.url), [RERANK_POOL[2].url, RERANK_POOL[1].url, RERANK_POOL[0].url]);
  });

  await guarded('flag on through judgeClaims', async () => {
    const fake = fakeRerankFetch((d) => (d.includes('launch news') ? 0.9 : 0.1));
    const prompts = [];
    const llm = async (_k, _m, messages) => { prompts.push(String(messages[1].content)); return fakeReply('{"verdicts":[]}'); };
    await withFakeFetch(fake.fn, () => verifyFn('judgeClaims')({
      claims: [RERANK_CLAIM], scoredEvidence: RERANK_POOL, config: { stanceModel: 'm', evidenceRerank: true, rerankModel: 'jina-reranker-v3.5' },
      apiKey: 'k', callLLM: llm, product: RERANK_PRODUCT, env: { JINA_API_KEY: 'jk' },
    }));
    eq(`${label}: flag on makes one rerank call`, fake.bodies.length, 1);
    eq(`${label}: the rerank call uses the configured model`, fake.bodies[0]?.model, 'jina-reranker-v3.5');
    ok(`${label}: the judge sees the top-reranked source first`, prompts[0]?.includes(`1. ${RERANK_POOL[2].url}`));
  });

  await guarded('rerank failure falls back', async () => {
    const fake = fakeRerankFetch(() => 1, 500);
    const { value, warnings } = await quietWarn(() => pick({ apiKey: 'secret-jina-key', fetchImpl: fake.fn }));
    eq(`${label}: a rerank error falls back to today's selection`, value, today());
    eq(`${label}: a rerank error logs one warning`, warnings.length, 1);
    ok(`${label}: the warning names the claim id`, warnings[0]?.includes('c3'));
    ok(`${label}: the warning has no key`, !warnings[0]?.includes('secret-jina-key'));

    const thrower = async () => { throw new Error('network down'); };
    const net = await quietWarn(() => pick({ apiKey: 'jk', fetchImpl: thrower }));
    eq(`${label}: a network error falls back to today's selection`, net.value, today());
  });

  await guarded('splitPassages', async () => {
    const split = exportOf(rerankModule, 'worker/engine/verify-rerank.js', 'splitPassages');
    const text = `${'A first sentence that is long enough to keep. '.repeat(3)}\n${'B'.repeat(150)}`;
    const parts = split(text, 100);
    ok(`${label}: every passage is at most maxChars`, parts.every((p) => p.length <= 100));
    ok(`${label}: passages end at a sentence end when one fits`, parts[0]?.endsWith('keep.'));
    eq(`${label}: no text is lost (except trimmed space)`, parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''));
    eq(`${label}: tiny fragments are dropped`, split('Menu. Home.', 100), []);
  });
}
