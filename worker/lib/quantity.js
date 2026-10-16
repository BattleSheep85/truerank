// Number-with-unit parsing for the stance backstops (CP-779).
//
// The stance judge sometimes marks a measurement that sits right next to the
// spec as a contradiction (SoundGuys measured 5 h 43 min against Apple's "up
// to 6 hours"). isNearSpecValue lets the backstop catch that case without an
// LLM: it compares the span's figures with the claim's figures, unit by unit.

// Relative gap treated as measurement noise (matches STANCE_SYSTEM's "about 3%").
export const NEAR_SPEC_TOLERANCE = 0.03;
// An "up to" / maximum claim also agrees with a typical figure this far below it.
export const UP_TO_TOLERANCE = 0.10;

const NUM = '(\\d+(?:\\.\\d+)?)';
const HOUR = '(?:h|hrs?|hours?)';
const MINUTE = '(?:m|mins?|minutes?)';
// "5 hours, 43 minutes", "5h 43m", "5 hr and 43 min".
const COMPOUND_TIME_RE = new RegExp(`${NUM}\\s*-?\\s*${HOUR}\\b[\\s,]*(?:and\\s+)?${NUM}\\s*${MINUTE}\\b`, 'gi');

// unit token → [dimension, factor to the dimension's base unit]
const UNITS = new Map([
  ['h', ['time', 60]], ['hr', ['time', 60]], ['hrs', ['time', 60]], ['hour', ['time', 60]], ['hours', ['time', 60]],
  ['min', ['time', 1]], ['mins', ['time', 1]], ['minute', ['time', 1]], ['minutes', ['time', 1]],
  ['mm', ['length', 1]], ['cm', ['length', 10]], ['inch', ['length', 25.4]], ['inches', ['length', 25.4]],
  ['g', ['mass', 1]], ['grams', ['mass', 1]], ['kg', ['mass', 1000]], ['oz', ['mass', 28.3495]],
  ['lb', ['mass', 453.592]], ['lbs', ['mass', 453.592]],
  ['w', ['power', 1]], ['watts', ['power', 1]], ['kw', ['power', 1000]],
  ['mah', ['charge', 1]], ['wh', ['energy', 1]],
  ['db', ['loudness', 1]], ['hz', ['frequency', 1]], ['khz', ['frequency', 1000]],
  ['nits', ['luminance', 1]], ['%', ['percent', 1]],
]);
// Bare "in" and "m" are left out on purpose: "6 in our test" is not inches.
const SINGLE_RE = /(\d+(?:\.\d+)?)\s*-?\s*(hours?|hrs?|h|minutes?|mins?|mm|cm|inch(?:es)?|grams|kg|g|oz|lbs?|watts|kw|w|mah|wh|db|khz|hz|nits|%)(?![a-z])/gi;
const UP_TO_RE = /\bup\s+to\b|\bmax(?:imum)?\b|\bpeak\b/i;

/**
 * Returns the figures in `text` as [{ dim, value }], each value in its
 * dimension's base unit (minutes, mm, g, ...). Never throws.
 */
export function extractQuantities(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  const rest = text.replace(COMPOUND_TIME_RE, (_m, h, m) => {
    out.push({ dim: 'time', value: Number(h) * 60 + Number(m) });
    return ' ';
  });
  for (const [, num, unit] of rest.matchAll(SINGLE_RE)) {
    const entry = UNITS.get(unit.toLowerCase());
    if (entry) out.push({ dim: entry[0], value: Number(num) * entry[1] });
  }
  return out;
}

function agrees(measured, claimed, upTo) {
  if (!(claimed > 0)) return false;
  const gap = (measured - claimed) / claimed;
  if (Math.abs(gap) <= NEAR_SPEC_TOLERANCE) return true;
  return upTo && gap < 0 && -gap <= UP_TO_TOLERANCE;
}

// A span figure equal to a claim figure is the spec quoted back ("Apple says
// 6 hours"), not a measurement.
function isQuotedSpec(q, claimed) {
  return claimed.some((c) => c.dim === q.dim && c.value === q.value);
}

/**
 * True when every figure in `span` that shares a unit dimension with a figure
 * in `claimText` agrees with one of the claim's figures (within
 * NEAR_SPEC_TOLERANCE, or up to UP_TO_TOLERANCE below an "up to" claim).
 * Figures equal to a claim figure are ignored as the spec quoted back.
 * False when no other figure shares a dimension, so a contradiction stated in
 * words ("Apple says 6 hours; ours managed three") is left alone. Never throws.
 */
export function isNearSpecValue(claimText, span) {
  const claimed = extractQuantities(claimText);
  const measured = extractQuantities(span);
  const upTo = typeof claimText === 'string' && UP_TO_RE.test(claimText);
  const dims = new Set(claimed.map((q) => q.dim));
  const shared = measured.filter((q) => dims.has(q.dim) && !isQuotedSpec(q, claimed));
  if (shared.length === 0) return false;
  return shared.every((m) => claimed.some((c) => c.dim === m.dim && agrees(m.value, c.value, upTo)));
}
