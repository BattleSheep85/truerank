// Deterministic verdict core for product-claims verification. Given a claim
// and a list of evidence (each carrying a `credibility`/`independence` from
// `worker/lib/credibility.js`'s scoreSource()), produces a stable, repeatable
// verdict — same evidence in, identical verdict out. No Date.now(), no
// randomness, no reliance on input array order (every sort is stable and
// tie-broken).
//
// Pure functions, no network, no mutation of inputs.

// A single piece of evidence's stance toward a claim.
export const STANCE = Object.freeze({
  SUPPORT: 'support',
  CONTRADICT: 'contradict',
  NEUTRAL: 'neutral',
});

// Weight thresholds for verdictForClaim's status decision (see below). Tuned
// so a single independent expert hands-on source (cred ~90, indep ~70 →
// weight ~0.63) alone reaches 'verified' territory, while a lone
// manufacturer self-claim (indep ~10) can never clear WEAK_SUPPORT on its own.
export const STRONG_SUPPORT = 1.0;
export const WEAK_SUPPORT = 0.3;
export const CONTRADICT_MIN = 0.5;
export const LOW_CONTRADICT = 0.25;

// overallVerdict() score bands + labels, evaluated highest-first.
const SCORE_BANDS = [
  { min: 80, label: 'Lives up to its claims' },
  { min: 60, label: 'Mostly holds up' },
  { min: 40, label: 'Mixed — verify the specifics' },
  { min: 20, label: 'Falls short of its claims' },
  { min: 0, label: 'Does not live up to its claims' },
];

// Per-status contribution to the overall score (see overallVerdict). Only
// decided statuses are here: an unsubstantiated claim counts neither for nor
// against the product (spec section 4.5).
const STATUS_VALUE = Object.freeze({
  verified: 1.0,
  'partially-verified': 0.5,
  contradicted: 0.0,
});

// overallVerdict() gives no number when independent evidence decided fewer
// than MIN_CHECKED_CLAIMS claims, or less than MIN_CHECKED_SHARE of them.
export const MIN_CHECKED_CLAIMS = 2;
export const MIN_CHECKED_SHARE = 0.25;
export const INSUFFICIENT_EVIDENCE_LABEL = 'Not enough independent evidence';

// Per-claim-type weight multiplier for overallVerdict's weighted mean. Spec
// and warranty claims are the most consequential to get wrong (a false spec
// or warranty claim is a hard factual failure); marketing claims are largely
// subjective puffery and count for less; support claims (policies, response
// times, etc.) count at the baseline.
const CLAIM_TYPE_WEIGHT = Object.freeze({
  spec: 1.5,
  warranty: 1.5,
  marketing: 0.75,
  support: 1.0,
});
const DEFAULT_CLAIM_TYPE_WEIGHT = 1.0;

function round2(x) {
  return Math.round(x * 100) / 100;
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Clamps a number to [0, 1]; NaN/undefined/non-finite → 0. */
export function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * Combined weight in [0,1] of a single piece of evidence: how much it should
 * count as corroboration (or contradiction). Missing/NaN credibility or
 * independence is treated as 0. This is why manufacturer/marketing
 * self-claims (independence ~10) barely count, while an independent expert
 * hands-on source (credibility ~90, independence ~70) counts strongly.
 */
export function evidenceWeight(ev) {
  const cred = clamp01((ev && ev.credibility) / 100);
  const indep = clamp01((ev && ev.independence) / 100);
  return cred * indep;
}

/**
 * Evidence weight for a VERIFICATION context (strict-(a)): a genuine hands-on
 * measurement counts even when the outlet carries affiliate links — a
 * measurement is a measurement — but that forgiveness applies ONLY to
 * hands-on/expert testing. Affiliate opinion without testing, sponsored
 * posts, incentivized reviews, manufacturer restatements, and opinion
 * listicles stay heavily discounted. Requires evidence items to carry `tags`
 * (the array produced by `scoreSource` in `worker/lib/credibility.js`).
 */
export function verificationWeight(ev) {
  const tags = (ev && ev.tags) || [];
  const has = (t) => tags.includes(t);
  if (has('ai-injection')) return 0; // manipulation — never counts

  const handsOn = has('hands-on') || has('expert-domain'); // someone actually tested/measured
  let testing;
  if (handsOn) testing = 1.0;
  else if (has('community')) testing = 0.6; // real unpaid users, but anecdotal
  else testing = 0.3; // opinion/blog/listicle/manufacturer restatement, untested

  let indep = clamp01((ev && ev.independence) / 100);
  if (handsOn) indep = Math.max(indep, 0.5); // strict-(a): a measurement counts even from a monetized outlet

  let mult = 1;
  if (has('sponsored-content')) mult *= 0.15;
  if (has('incentivized-review')) mult *= 0.15;
  if (has('manufacturer')) mult *= 0.2; // maker restating its own claim ≠ corroboration
  if (has('affiliate-conflict')) mult *= handsOn ? 0.9 : 0.4; // forgive ONLY when there's a measurement
  if (has('listicle') && !handsOn) mult *= 0.4;

  return clamp01(testing * indep * mult);
}

// Tags that disqualify an evidence item from counting as a genuine
// independent corroborator under the verification policy, even if its weight
// clears the threshold (e.g. a manufacturer restatement can still carry some
// residual weight but must never count toward corroboration).
const NON_INDEPENDENT_TAGS = Object.freeze([
  'manufacturer',
  'sponsored-content',
  'incentivized-review',
  'ai-injection',
]);

// Minimum weigh() score for an item to count as a "real, non-trivial" source
// when tallying independent corroborators (tier-(iii) verification policy).
const CORROBORATOR_MIN_WEIGHT = 0.25;

/** Strips a leading "www." from a hostname (case-sensitive match, as hostnames are already lowercase). */
function stripWww(hostname) {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

/**
 * Counts DISTINCT hostnames among `supporting` items that qualify as genuine
 * independent corroborators: weigh(item) >= CORROBORATOR_MIN_WEIGHT AND none
 * of NON_INDEPENDENT_TAGS present in item.tags. Two pages on the same host
 * count once. Invalid/missing URLs are skipped (can't establish a distinct
 * host). Pure — does not mutate `supporting`.
 */
export function independentCorroborators(supporting, weigh) {
  const items = Array.isArray(supporting) ? supporting : [];
  const hosts = new Set();
  for (const item of items) {
    if (!item) continue;
    if (weigh(item) < CORROBORATOR_MIN_WEIGHT) continue;
    const tags = item.tags || [];
    if (NON_INDEPENDENT_TAGS.some((t) => tags.includes(t))) continue;
    try {
      hosts.add(stripWww(new URL(item.url).hostname));
    } catch {
      continue; // invalid/missing URL — can't establish a distinct host
    }
  }
  return hosts.size;
}

const MIN_INDEPENDENT_CORROBORATORS = 2;

function byWeightDescUrlAsc(a, b) {
  if (b._weight !== a._weight) return b._weight - a._weight;
  const ua = a.url || '';
  const ub = b.url || '';
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  return 0;
}

function sortedSide(items, weigh) {
  return items
    .map((ev) => ({ ...ev, _weight: weigh(ev) }))
    .sort(byWeightDescUrlAsc)
    .map(({ _weight, ...rest }) => ({ ...rest, weight: round3(_weight) }));
}

/**
 * Deterministic verdict for a single claim given its evidence list. Same
 * input always produces an identical (deep-equal) output, including array
 * order — no Date.now(), no randomness.
 *
 * Returns { status, confidence, support, contradict, supporting, contradicting }.
 *
 * `opts.weigh` overrides the per-evidence weighting function (default
 * `evidenceWeight`) — e.g. pass `verificationWeight` for a verification
 * context. Default behavior (no opts) is unchanged.
 *
 * `opts.policy === 'verification'` additionally applies tier-(iii)
 * corroboration caps on top of the base status (see independentCorroborators
 * above): marketing claims can never reach 'verified', and spec/warranty/
 * support/unknown claims need >= 2 distinct-host independent corroborators
 * to reach 'verified' — otherwise they're downgraded to 'partially-verified'.
 * Contradicted is unchanged (evaluated first, always wins). When this policy
 * is active and `opts.weigh` is not given, `weigh` defaults to
 * verificationWeight (not evidenceWeight) since the policy is meaningless
 * without tag-aware weighting. The returned object always carries
 * `independentCount` (the distinct-host independent-corroborator count among
 * `supporting`, per independentCorroborators() above) regardless of policy,
 * so callers/UI can surface it either way.
 */
export function verdictForClaim(claim, evidence, opts = {}) {
  const policy = opts && opts.policy;
  const defaultWeigh = policy === 'verification' ? verificationWeight : evidenceWeight;
  const weigh = (opts && opts.weigh) || defaultWeigh;
  const list = Array.isArray(evidence) ? evidence : [];

  const supportItems = list.filter((ev) => ev && ev.stance === STANCE.SUPPORT);
  const contradictItems = list.filter((ev) => ev && ev.stance === STANCE.CONTRADICT);

  const support = supportItems.reduce((sum, ev) => sum + weigh(ev), 0);
  const contradict = contradictItems.reduce((sum, ev) => sum + weigh(ev), 0);

  let status;
  if (contradict >= CONTRADICT_MIN && contradict > support) {
    status = 'contradicted';
  } else if (support >= STRONG_SUPPORT && contradict < LOW_CONTRADICT) {
    status = 'verified';
  } else if (support >= WEAK_SUPPORT) {
    status = 'partially-verified';
  } else {
    status = 'unsubstantiated';
  }

  const independentCount = independentCorroborators(supportItems, weigh);

  if (policy === 'verification' && status === 'verified') {
    if (claim && claim.type === 'marketing') {
      status = 'partially-verified'; // puffery is partially-verified at best
    } else if (independentCount < MIN_INDEPENDENT_CORROBORATORS) {
      status = 'partially-verified'; // spec/warranty/support need >=2 independent corroborators
    }
  }

  // Confidence = winning-side strength × separation between the two sides.
  // Both factors are pure functions of support/contradict, so this is
  // deterministic and monotonic in the winning margin.
  const winner = Math.max(support, contradict);
  const total = support + contradict;
  const separation = total > 0 ? Math.abs(support - contradict) / Math.max(0.001, total) : 0;
  const confidence = round2(Math.min(1, winner) * separation);

  return {
    status,
    confidence,
    support: round3(support),
    contradict: round3(contradict),
    supporting: sortedSide(supportItems, weigh),
    contradicting: sortedSide(contradictItems, weigh),
    independentCount,
  };
}

function scoreBandLabel(score) {
  for (const band of SCORE_BANDS) {
    if (score >= band.min) return band.label;
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1].label;
}

function isDecided(cv) {
  return Boolean(cv) && Object.hasOwn(STATUS_VALUE, cv.status);
}

function hasEnoughEvidence(checkedCount, claimCount) {
  return claimCount > 0
    && checkedCount >= MIN_CHECKED_CLAIMS
    && checkedCount / claimCount >= MIN_CHECKED_SHARE;
}

/**
 * Aggregates a set of per-claim verdicts (as produced by verdictForClaim,
 * each additionally carrying a `claimType`) into an overall score/label.
 *
 * Only decided claims feed the score: verified=1.0, partially-verified=0.5,
 * contradicted=0.0. Unsubstantiated (and unknown) statuses count toward
 * claimCount only. Each decided claim is weighted by claim type (spec and
 * warranty 1.5x, support 1.0x, marketing 0.75x, unknown types 1.0x). score is
 * round(100 * weightedMean) over decided claims, and SCORE_BANDS give the label.
 *
 * score is null and label is INSUFFICIENT_EVIDENCE_LABEL when claimCount is 0,
 * checkedCount < MIN_CHECKED_CLAIMS, or checkedCount / claimCount <
 * MIN_CHECKED_SHARE. A non-array input acts like [].
 *
 * @param {Array<{status: string, claimType?: string}>} claimVerdicts
 * @returns {{ score: number|null, label: string, checkedCount: number, claimCount: number }}
 */
export function overallVerdict(claimVerdicts) {
  const list = Array.isArray(claimVerdicts) ? claimVerdicts : [];
  const decided = list.filter(isDecided);
  const claimCount = list.length;
  const checkedCount = decided.length;
  if (!hasEnoughEvidence(checkedCount, claimCount)) {
    return { score: null, label: INSUFFICIENT_EVIDENCE_LABEL, checkedCount, claimCount };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  for (const cv of decided) {
    const weight = Object.hasOwn(CLAIM_TYPE_WEIGHT, cv.claimType) ? CLAIM_TYPE_WEIGHT[cv.claimType] : DEFAULT_CLAIM_TYPE_WEIGHT;
    weightedSum += STATUS_VALUE[cv.status] * weight;
    weightTotal += weight;
  }

  const score = Math.round((100 * weightedSum) / weightTotal);
  return { score, label: scoreBandLabel(score), checkedCount, claimCount };
}
