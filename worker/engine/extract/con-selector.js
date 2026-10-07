// Gated LLM con-SELECTOR — the ONLY place the honest-by-construction extraction
// pipeline lets an LLM touch output, and it is fenced on both sides:
//   IN:  only real source sentences about ONE product (from conCandidateSpans).
//   OUT: a hard groundedness gate DROPS any returned con whose text is not a substring
//        of those sentences. The LLM SELECTS criticism; it can never GENERATE it.
// Used to fill cons for products where the deterministic lexicon found too few — the
// LLM is far better at recognizing a drawback phrased without a sentiment keyword
// ("the app is required to change EQ"), but it is allowed to recognize, not invent.
import { callLLM } from '../llm.js';
import { routeHasKey } from '../../lib/llm-route.js';
import { sentencePolarity } from './engine.js';
import { norm } from './text.js';

// "video playback isn't a problem", "no issues", "not a dealbreaker" — a NEGATED
// negative is PRAISE, not a con. The grounding gate can't catch this (it's a real
// span); a polarity guard must.
const POSITIVE_NEGATION = /\b(?:isn'?t|aren'?t|wasn'?t|not|no|never|without|hardly|rarely) (?:a |an |any |really |much )?(?:problem|issue|issues|con|cons|downside|drawback|deal.?breaker|complaint|concern|trouble|fuss|compromise|sacrifice|disappoint\w*)\b/i;

const SELECT_SYSTEM = `You extract CRITICISM for an honesty-first product tool. You are given numbered REVIEW SENTENCES about ONE product. Return only the ones that state a DRAWBACK, limitation, complaint, missing feature, or caveat about THIS product.

HARD RULES:
1. Use ONLY words that appear in the provided sentences — quote a sentence or a contiguous sub-span of it. Light trimming of edges is fine.
2. NEVER add a fact, number, spec, brand, or source that is not in the sentences. Inventing anything is a critical failure.
3. A neutral or positive sentence is NOT a con — omit it.
4. If NO sentence states a real drawback, return an empty list. An empty list is the correct, honest answer when there is no criticism.
Output ONLY JSON: {"cons":[{"text":"<verbatim drawback span>"}]}.`;

const SCHEMA = { type: 'object', additionalProperties: false, required: ['cons'], properties: { cons: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } } } } };

// Returns grounded con strings (each verified as a substring of `spans`). [] on any
// failure — the engine keeps whatever deterministic cons it already had.
export async function selectCons(productName, spans, apiKey, model, maxCons = 3) {
  if (!routeHasKey(apiKey) || !model || !Array.isArray(spans) || spans.length === 0) return [];
  const numbered = spans.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const messages = [
    { role: 'system', content: SELECT_SYSTEM },
    { role: 'user', content: `PRODUCT: ${productName}\n\nREVIEW SENTENCES:\n${numbered}\n\nReturn the drawback spans as JSON.` },
  ];
  let parsed = null;
  try {
    const r = await callLLM(apiKey, model, messages, {
      maxTokens: 700,
      reasoning: { enabled: false },
      responseFormat: { type: 'json_schema', json_schema: { name: 'cons', strict: true, schema: SCHEMA } },
      hardMsOverride: 30000,
    });
    parsed = JSON.parse(r.choices?.[0]?.message?.content ?? '');
  } catch { return []; }

  // GROUNDEDNESS GATE — drop any con not traceable to the supplied spans.
  const corpus = ' ' + spans.map(norm).join(' ') + ' ';
  const out = []; const used = new Set();
  for (const c of (Array.isArray(parsed?.cons) ? parsed.cons : [])) {
    const t = String(c?.text || '').trim();
    const g = norm(t);
    if (g.length < 8 || t.length > 220) continue;
    if (!corpus.includes(g)) continue;          // invented / paraphrased-too-far → DROP
    if (POSITIVE_NEGATION.test(t)) continue;     // "isn't a problem" = praise, not a con
    if (sentencePolarity(t).score >= 0.8) continue; // clearly-positive span → not a con
    if (used.has(g)) continue;
    used.add(g); out.push(t);
    if (out.length >= maxCons) break;
  }
  return out;
}
