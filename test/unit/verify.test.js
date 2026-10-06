// Truth Audit pure-logic coverage: isMarketingEcho, applyStanceBackstops,
// buildClaimEvidence, topEvidenceForClaim — the deterministic backstop/join
// logic ported into worker/engine/verify.js (single source of truth, also
// used by benchmarks/verify-product.mjs).
//
// Namespace import on purpose: claimTerms and claimPassage (piece 9) can be
// missing from the module. A static named import of a missing export would
// stop scripts/run-tests.mjs from loading at all.
import * as verifyModule from '../../worker/engine/verify.js';
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
