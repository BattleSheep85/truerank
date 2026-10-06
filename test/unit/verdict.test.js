// Deterministic verdict-core coverage: evidenceWeight/clamp01, verdictForClaim
// (status thresholds, confidence, sort/tie-break, determinism), and
// overallVerdict (honest score over decided claims only, claim-type
// weighting, score bands, the not-enough-evidence state).
import {
  clamp01,
  evidenceWeight,
  verificationWeight,
  verdictForClaim,
  overallVerdict,
  independentCorroborators,
  CONTRADICT_MIN,
  WEAK_SUPPORT,
} from '../../worker/lib/verdict.js';
// Namespace import for the refocus 2026-10 constants: a missing export then
// fails only these assertions, not the load of every suite in the runner.
import * as verdictLib from '../../worker/lib/verdict.js';

export function runVerdictTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── clamp01 / evidenceWeight ────────────────────────────────────────────
  eq('clamp01(0) → 0', clamp01(0), 0);
  eq('clamp01(1) → 1', clamp01(1), 1);
  eq('clamp01(-5) → 0', clamp01(-5), 0);
  eq('clamp01(5) → 1', clamp01(5), 1);
  eq('clamp01(NaN) → 0', clamp01(NaN), 0);
  eq('clamp01(undefined) → 0', clamp01(undefined), 0);

  eq('weight cred=0 indep=0 → 0', evidenceWeight({ credibility: 0, independence: 0 }), 0);
  eq('weight cred=100 indep=100 → 1', evidenceWeight({ credibility: 100, independence: 100 }), 1);
  eq('weight out-of-range clamps → 0', evidenceWeight({ credibility: 150, independence: -10 }), 0);
  eq('weight NaN credibility → 0', evidenceWeight({ credibility: NaN, independence: 50 }), 0);
  eq('weight missing fields → 0', evidenceWeight({}), 0);
  ok('weight always in [0,1]', evidenceWeight({ credibility: 999, independence: 999 }) <= 1);

  // ── determinism ──────────────────────────────────────────────────────────
  {
    const evidence = [
      { url: 'https://b.com', stance: 'support', credibility: 80, independence: 60 },
      { url: 'https://a.com', stance: 'support', credibility: 80, independence: 60 },
      { url: 'https://c.com', stance: 'contradict', credibility: 50, independence: 40 },
    ];
    const r1 = verdictForClaim('claim', evidence);
    const r2 = verdictForClaim('claim', evidence);
    eq('determinism: identical evidence → deep-equal output', JSON.stringify(r1), JSON.stringify(r2));
  }

  // ── verified: two independent high-cred/high-indep supporters ──────────
  {
    const v = verdictForClaim('battery lasts 20 hours', [
      { url: 'https://expert1.com', stance: 'support', credibility: 90, independence: 70 },
      { url: 'https://expert2.com', stance: 'support', credibility: 85, independence: 65 },
    ]);
    eq('verified status', v.status, 'verified');
    ok('verified support >= STRONG_SUPPORT', v.support >= 1.0);
    eq('verified contradict = 0', v.contradict, 0);
  }

  // ── contradicted: credible independent contradiction beats support ─────
  {
    const v = verdictForClaim('waterproof to 100m', [
      { url: 'https://mfg.com', stance: 'support', credibility: 40, independence: 30 },
      { url: 'https://expert.com', stance: 'contradict', credibility: 90, independence: 70 },
    ]);
    eq('contradicted status', v.status, 'contradicted');
    ok('contradict >= CONTRADICT_MIN', v.contradict >= CONTRADICT_MIN);
    ok('contradict > support', v.contradict > v.support);
  }

  // ── unsubstantiated: manufacturer-only low-independence support ────────
  {
    const v = verdictForClaim('best in class', [
      { url: 'https://manufacturer.com', stance: 'support', credibility: 40, independence: 10 },
    ]);
    eq('unsubstantiated status', v.status, 'unsubstantiated');
    ok('manufacturer weight tiny (< WEAK_SUPPORT)', v.support < WEAK_SUPPORT);
  }

  // ── partially-verified: support between WEAK and STRONG, low contradiction ─
  {
    const v = verdictForClaim('comfortable for all-day wear', [
      { url: 'https://reviewer.com', stance: 'support', credibility: 70, independence: 60 },
    ]);
    eq('partially-verified status', v.status, 'partially-verified');
    ok('support >= WEAK_SUPPORT', v.support >= WEAK_SUPPORT);
    ok('support < STRONG_SUPPORT', v.support < 1.0);
  }

  // ── weighting: one strong expert outweighs three weak blog mentions ────
  {
    const strong = { url: 'https://expert.com', stance: 'support', credibility: 90, independence: 75 };
    const weak = (i) => ({ url: `https://blog${i}.com`, stance: 'support', credibility: 30, independence: 30 });

    const weakOnly = verdictForClaim('claim', [weak(1), weak(2), weak(3)]);
    eq('three weak blogs alone → unsubstantiated', weakOnly.status, 'unsubstantiated');

    const withStrong = verdictForClaim('claim', [strong, weak(1), weak(2), weak(3)]);
    ok('adding the strong source lifts status past unsubstantiated', withStrong.support >= WEAK_SUPPORT);
    ok('single strong source contributes most of the weight', evidenceWeight(strong) > evidenceWeight(weak(1)) * 3);
  }

  // ── sort / tie-break ─────────────────────────────────────────────────────
  {
    const v = verdictForClaim('claim', [
      { url: 'https://low.com', stance: 'support', credibility: 40, independence: 40 },
      { url: 'https://high.com', stance: 'support', credibility: 90, independence: 90 },
      { url: 'https://z-tie.com', stance: 'support', credibility: 80, independence: 80 },
      { url: 'https://a-tie.com', stance: 'support', credibility: 80, independence: 80 },
    ]);
    eq(
      'supporting sorted by weight desc, tie-broken by url asc',
      v.supporting.map((e) => e.url),
      ['https://high.com', 'https://a-tie.com', 'https://z-tie.com', 'https://low.com']
    );
    ok('weights rounded to 3 decimals', v.supporting.every((e) => Number.isFinite(e.weight)));
  }

  // ── overallVerdict: band labels (every claim decided) ───────────────────
  {
    const highBand = overallVerdict([
      { status: 'verified', claimType: 'spec' },
      { status: 'verified', claimType: 'spec' },
      { status: 'verified', claimType: 'marketing' },
      { status: 'partially-verified', claimType: 'support' },
    ]);
    ok('~89 band lands >= 80', highBand.score >= 80);
    eq('~89 band label', highBand.label, 'Lives up to its claims');

    const midHighBand = overallVerdict([
      { status: 'verified', claimType: 'support' },
      { status: 'partially-verified', claimType: 'support' },
    ]);
    ok('~75 band lands in [60,80)', midHighBand.score >= 60 && midHighBand.score < 80);
    eq('~75 band label', midHighBand.label, 'Mostly holds up');

    const midBand = overallVerdict([
      { status: 'partially-verified', claimType: 'support' },
      { status: 'partially-verified', claimType: 'support' },
    ]);
    ok('~50 band lands in [40,60)', midBand.score >= 40 && midBand.score < 60);
    eq('~50 band label', midBand.label, 'Mixed — verify the specifics');

    const lowBand = overallVerdict([
      { status: 'partially-verified', claimType: 'support' },
      { status: 'contradicted', claimType: 'support' },
    ]);
    ok('~25 band lands in [20,40)', lowBand.score >= 20 && lowBand.score < 40);
    eq('~25 band label', lowBand.label, 'Falls short of its claims');

    const bottomBand = overallVerdict([
      { status: 'partially-verified', claimType: 'support' },
      { status: 'contradicted', claimType: 'support' },
      { status: 'contradicted', claimType: 'support' },
      { status: 'contradicted', claimType: 'support' },
    ]);
    ok('~13 band lands < 20', bottomBand.score < 20);
    eq('~13 band label', bottomBand.label, 'Does not live up to its claims');
  }

  // ── overallVerdict: honest score over decided claims only (spec 4.5) ────
  {
    const { MIN_CHECKED_CLAIMS, MIN_CHECKED_SHARE, INSUFFICIENT_EVIDENCE_LABEL } = verdictLib;
    eq('MIN_CHECKED_CLAIMS is 2', MIN_CHECKED_CLAIMS, 2);
    eq('MIN_CHECKED_SHARE is 0.25', MIN_CHECKED_SHARE, 0.25);
    eq('INSUFFICIENT_EVIDENCE_LABEL text', INSUFFICIENT_EVIDENCE_LABEL, 'Not enough independent evidence');

    const claims = (status, n) => Array.from({ length: n }, () => ({ status, claimType: 'support' }));
    // Compare field by field so the key order of the result does not matter.
    const fields = (name, actual, expected) => {
      for (const [k, v] of Object.entries(expected)) eq(`${name}: ${k}`, actual ? actual[k] : actual, v);
    };
    const noNumber = { score: null, label: INSUFFICIENT_EVIDENCE_LABEL };

    fields('[] → no number', overallVerdict([]), { ...noNumber, checkedCount: 0, claimCount: 0 });
    fields('undefined → no number', overallVerdict(undefined), { ...noNumber, checkedCount: 0, claimCount: 0 });
    fields('4 unsubstantiated → no number', overallVerdict(claims('unsubstantiated', 4)),
      { ...noNumber, checkedCount: 0, claimCount: 4 });
    fields('1 verified + 3 unsubstantiated → no number (1 decided < 2)',
      overallVerdict([...claims('verified', 1), ...claims('unsubstantiated', 3)]),
      { ...noNumber, checkedCount: 1, claimCount: 4 });
    fields('2 verified + 7 unsubstantiated → no number (2/9 < 0.25)',
      overallVerdict([...claims('verified', 2), ...claims('unsubstantiated', 7)]),
      { ...noNumber, checkedCount: 2, claimCount: 9 });
    fields('2 verified + 6 unsubstantiated → 100 (2/8 meets the floor)',
      overallVerdict([...claims('verified', 2), ...claims('unsubstantiated', 6)]),
      { score: 100, label: 'Lives up to its claims', checkedCount: 2, claimCount: 8 });

    const decidedOnly = overallVerdict([...claims('verified', 1), ...claims('contradicted', 1)]);
    const withUnsubstantiated = overallVerdict([
      ...claims('verified', 1), ...claims('contradicted', 1), ...claims('unsubstantiated', 2),
    ]);
    ok('decided-only score is a number', typeof decidedOnly.score === 'number');
    eq('unsubstantiated claims do not move the score', withUnsubstantiated.score, decidedOnly.score);
  }

  // ── verificationWeight (strict-(a): hands-on measurement survives affiliate) ─
  {
    // hands-on + affiliate-conflict: the measurement forgiveness kicks in —
    // weight should be materially higher than the SAME source's plain
    // evidenceWeight (which has no hands-on forgiveness for affiliate taint).
    const handsOnAffiliate = {
      credibility: 70,
      independence: 40,
      tags: ['hands-on', 'affiliate-conflict'],
    };
    const vw = verificationWeight(handsOnAffiliate);
    const ew = evidenceWeight(handsOnAffiliate);
    ok('hands-on+affiliate verificationWeight >= 0.4', vw >= 0.4);
    ok('hands-on+affiliate verificationWeight > its own evidenceWeight', vw > ew);

    // affiliate-conflict WITHOUT hands-on stays strict.
    const affiliateOnly = { credibility: 60, independence: 40, tags: ['affiliate-conflict'] };
    ok('affiliate-conflict without hands-on stays <= 0.25', verificationWeight(affiliateOnly) <= 0.25);

    // sponsored-content is heavily discounted regardless of independence.
    const sponsored = { credibility: 60, independence: 50, tags: ['sponsored-content'] };
    ok('sponsored-content weight <= 0.15', verificationWeight(sponsored) <= 0.15);

    // manufacturer restatement is heavily discounted.
    const manufacturer = { credibility: 50, independence: 100, tags: ['manufacturer'] };
    ok('manufacturer weight <= 0.2', verificationWeight(manufacturer) <= 0.2);

    // ai-injection is manipulation — always exactly 0, no matter the rest.
    const injected = { credibility: 100, independence: 100, tags: ['ai-injection', 'hands-on'] };
    eq('ai-injection weight === 0', verificationWeight(injected), 0);

    // clean expert-domain hands-on source with decent independence clears 0.6.
    const expertHandsOn = { credibility: 90, independence: 70, tags: ['hands-on', 'expert-domain'] };
    ok('expert-domain hands-on clean weight >= 0.6', verificationWeight(expertHandsOn) >= 0.6);

    // listicle opinion, no hands-on testing, stays low.
    const listicleOnly = { credibility: 50, independence: 50, tags: ['listicle'] };
    ok('listicle-only opinion weight <= 0.25', verificationWeight(listicleOnly) <= 0.25);
  }

  // ── verdictForClaim with opts.weigh: verification context vs default ───
  {
    // Low independence (20) keeps default evidenceWeight tiny (cred×indep),
    // while verificationWeight's hands-on floor (indep >= 0.5) plus the
    // affiliate-conflict forgiveness (×0.9 instead of ×0.4) lifts it well
    // above the default — this is exactly the strict-(a) forgiveness case.
    const handsOnAffiliateA = {
      url: 'https://a.com',
      stance: 'support',
      credibility: 55,
      independence: 20,
      tags: ['hands-on', 'affiliate-conflict'],
    };
    const handsOnAffiliateB = {
      url: 'https://b.com',
      stance: 'support',
      credibility: 55,
      independence: 20,
      tags: ['hands-on', 'affiliate-conflict'],
    };
    const evidence = [handsOnAffiliateA, handsOnAffiliateB];

    const verificationVerdict = verdictForClaim('measured battery life', evidence, { weigh: verificationWeight });
    ok(
      'verification-weighted verdict reaches verified/partially-verified',
      verificationVerdict.status === 'verified' || verificationVerdict.status === 'partially-verified',
    );

    const defaultVerdict = verdictForClaim('measured battery life', evidence);
    eq('default-weighted verdict on the same evidence stays unsubstantiated', defaultVerdict.status, 'unsubstantiated');

    ok('the two weighting modes disagree on status', verificationVerdict.status !== defaultVerdict.status);
  }

  // ── regression: verdictForClaim with no opts is unchanged ──────────────
  {
    // Re-assert one of the earlier no-opts scenarios explicitly to document
    // that omitting opts is still byte-identical to the pre-change behavior.
    const v = verdictForClaim('battery lasts 20 hours', [
      { url: 'https://expert1.com', stance: 'support', credibility: 90, independence: 70 },
      { url: 'https://expert2.com', stance: 'support', credibility: 85, independence: 65 },
    ]);
    eq('regression: no-opts verified status unchanged', v.status, 'verified');
  }

  // ── tier-(iii): opts.policy === 'verification' corroboration caps ──────
  {
    // ONE strong independent hands-on source alone (cred=100, indep=100 so
    // default evidenceWeight reaches STRONG_SUPPORT on its own): verified
    // without the policy, but the policy requires >= 2 independent
    // corroborators, so the SAME evidence downgrades to partially-verified
    // under the policy.
    const oneHandsOn = {
      url: 'https://expert1.com',
      stance: 'support',
      credibility: 100,
      independence: 100,
      tags: ['hands-on', 'expert-domain'],
    };
    const specClaim = { type: 'spec', text: 'battery lasts 20 hours' };

    const withPolicy = verdictForClaim(specClaim, [oneHandsOn], { policy: 'verification' });
    eq('spec + 1 independent hands-on source, policy=verification → partially-verified', withPolicy.status, 'partially-verified');
    eq('independentCount === 1 for the single-source case', withPolicy.independentCount, 1);

    const noPolicy = verdictForClaim(specClaim, [oneHandsOn]);
    eq('same call withOUT policy → verified (default weighing, no caps)', noPolicy.status, 'verified');

    // TWO independent hands-on sources on distinct hosts → verified.
    const secondHandsOn = {
      url: 'https://expert2.com',
      stance: 'support',
      credibility: 88,
      independence: 68,
      tags: ['hands-on', 'expert-domain'],
    };
    const twoIndependent = verdictForClaim(specClaim, [oneHandsOn, secondHandsOn], { policy: 'verification' });
    eq('spec + 2 independent hands-on sources on distinct hosts → verified', twoIndependent.status, 'verified');
    eq('independentCount === 2 for the two-distinct-host case', twoIndependent.independentCount, 2);

    // TWO strong supports on the SAME host → counts as 1 independent corroborator.
    const sameHostA = {
      url: 'https://reviews.samehost.com/a',
      stance: 'support',
      credibility: 90,
      independence: 70,
      tags: ['hands-on', 'expert-domain'],
    };
    const sameHostB = {
      url: 'https://reviews.samehost.com/b',
      stance: 'support',
      credibility: 88,
      independence: 68,
      tags: ['hands-on', 'expert-domain'],
    };
    const sameHostVerdict = verdictForClaim(specClaim, [sameHostA, sameHostB], { policy: 'verification' });
    eq('two strong supports on the same host count as 1 → partially-verified', sameHostVerdict.status, 'partially-verified');
    eq('independentCount === 1 for the same-host case', sameHostVerdict.independentCount, 1);

    // ONE hands-on + ONE manufacturer-tagged support → manufacturer doesn't count.
    const manufacturerSupport = {
      url: 'https://manufacturer.com',
      stance: 'support',
      credibility: 50,
      independence: 100,
      tags: ['manufacturer'],
    };
    const withManufacturer = verdictForClaim(specClaim, [oneHandsOn, manufacturerSupport], { policy: 'verification' });
    eq('manufacturer-tagged support excluded from corroborator count → independentCount === 1', withManufacturer.independentCount, 1);
    eq('hands-on + manufacturer (not independent) → partially-verified', withManufacturer.status, 'partially-verified');

    // Marketing claim + THREE strong independent sources → capped at partially-verified.
    const marketingClaim = { type: 'marketing', text: 'the best headphones ever made' };
    const marketingSupports = [1, 2, 3].map((i) => ({
      url: `https://marketing-expert${i}.com`,
      stance: 'support',
      credibility: 90,
      independence: 70,
      tags: ['hands-on', 'expert-domain'],
    }));
    const marketingVerdict = verdictForClaim(marketingClaim, marketingSupports, { policy: 'verification' });
    eq('marketing claim with 3 independent sources never reaches verified', marketingVerdict.status, 'partially-verified');
    ok('marketing claim independentCount reflects the 3 distinct hosts', marketingVerdict.independentCount === 3);

    // Contradicted case under policy:'verification' still returns contradicted:
    // a weak (manufacturer-tagged, heavily discounted) support is dominated by
    // a strong independent hands-on contradiction, so a real contradiction
    // always wins regardless of the corroboration caps.
    const weakManufacturerSupport = {
      url: 'https://mfg.com',
      stance: 'support',
      credibility: 40,
      independence: 100,
      tags: ['manufacturer'],
    };
    const contradictingExpert = {
      url: 'https://contradictor.com',
      stance: 'contradict',
      credibility: 90,
      independence: 70,
      tags: ['hands-on', 'expert-domain'],
    };
    const contradictedVerdict = verdictForClaim(specClaim, [weakManufacturerSupport, contradictingExpert], { policy: 'verification' });
    eq('contradiction still wins under policy=verification', contradictedVerdict.status, 'contradicted');
  }

  // ── independentCorroborators() helper directly ──────────────────────────
  {
    const support = [
      { url: 'https://one.example.com', tags: ['hands-on'] },
      { url: 'https://www.one.example.com/other-page', tags: ['hands-on'] }, // same host as above (www stripped)
      { url: 'https://two.example.com', tags: ['hands-on'] },
      { url: 'https://sponsored.example.com', tags: ['hands-on', 'sponsored-content'] },
      { url: 'not-a-valid-url', tags: ['hands-on'] },
    ];
    const weighAllStrong = () => 1.0; // every item clears the 0.25 threshold
    eq(
      'independentCorroborators: dedupes hosts, excludes disqualified tags, skips invalid URLs',
      independentCorroborators(support, weighAllStrong),
      2,
    );

    const weighAllWeak = () => 0.1; // below CORROBORATOR_MIN_WEIGHT
    eq('independentCorroborators: below-threshold weight excludes all', independentCorroborators(support, weighAllWeak), 0);
  }

  // ── overallVerdict: claim-type weighting ────────────────────────────────
  {
    // A contradicted spec claim (1.5x weight) should drag the score down more
    // than a contradicted marketing claim (0.75x weight) would, all else equal.
    const specContradicted = overallVerdict([
      { status: 'verified', claimType: 'support' },
      { status: 'contradicted', claimType: 'spec' },
    ]);
    const marketingContradicted = overallVerdict([
      { status: 'verified', claimType: 'support' },
      { status: 'contradicted', claimType: 'marketing' },
    ]);
    ok('weighted scores are numbers (2 of 2 claims decided)',
      typeof specContradicted.score === 'number' && typeof marketingContradicted.score === 'number');
    ok('spec contradiction weighs more than marketing contradiction', specContradicted.score < marketingContradicted.score);
  }

  return report;
}
