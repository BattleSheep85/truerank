// Gated LLM name-cleanup — the engine-shootout-v2 winner (approach B). The ML harvest is
// comprehensive + honest but its NAMES are rough (merges, chrome, fragments) and it keeps
// non-product junk (platforms, spec callouts). This adds the UNDERSTANDING the pure-ML
// heuristics can't: an LLM cleans each name + drops clear junk + dedups — CONSTRAINED to the
// ML candidate set (it can never invent a product) and PER-NAME groundedness-gated (a cleaned
// name may only use words already in the original). Conservative on drops (keep when unsure)
// so real products aren't lost. Selects + cleans, never generates.
import { callLLM } from '../llm.js';
import { routeHasKey } from '../../lib/llm-route.js';
import { parseFencedJson } from '../../lib/llm-json.js';

// Deliberate superset of the shared parseFencedJson: also strips HTML entities
// before collapsing non-alnum runs, which is load-bearing for the
// groundedness gate below (cleaned names are compared against decoded
// original text). Do NOT replace with the plain text.js `norm()`.
const gNorm = (s) => String(s || '').toLowerCase().replace(/&#?[a-z0-9]+;/g, ' ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['items'],
  properties: { items: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'keep', 'clean_name'],
    properties: { i: { type: 'integer' }, keep: { type: 'boolean' }, clean_name: { type: 'string' } },
  } } },
};

export async function cleanProducts(report, query, topicalCategory, apiKey, model) {
  if (!routeHasKey(apiKey) || !model || !report || !Array.isArray(report.products) || report.products.length === 0) return report;
  const list = report.products.map((p, i) => `${i}: ${p.name}`).join('\n');
  const messages = [{
    role: 'user',
    content: `The user wants: "${query}" — i.e. a "${topicalCategory || ''}" (a specific PRODUCT TYPE).
Below are candidate product names extracted verbatim from review sources. For EVERY index decide keep/drop:
DROP (keep=false) if the item is NOT an actual "${topicalCategory || 'product'}" unit, specifically:
  (a) a DIFFERENT product type — a hub / bridge / gateway / controller / coordinator / chip / dongle / sensor / switch / plug, software / app / firmware / protocol, a platform or voice assistant, or an accessory / part — EVEN IF it is compatible with or part of the same ecosystem. The user wants the "${topicalCategory}" itself, not the things around it. (e.g. for "smart light bulbs": drop "Home Assistant Zigbee2MQTT", "Philips Hue Bridge", "Texas Instruments CC2652". For "espresso machines": drop a coffee GRINDER.)
  (b) a spec/feature fragment or non-product phrase ("Standard E26 Base", "Affordable IPX7", "White 800 2200K", "Kit Glasses", "Amazon See", "Avoid CC2531").
  (c) an obvious DUPLICATE of another row.
KEEP (keep=true) every actual "${topicalCategory}" unit. When you are UNSURE whether something is a real product OF THIS TYPE, keep=true — never drop a plausibly-real "${topicalCategory}".
For kept rows, clean_name = the real product name with any two-product merge split off and chrome/review words removed.
HARD RULE: clean_name may use ONLY words that already appear in that row's original name; do NOT add, translate, or invent words. Return one entry per index.

${list}`,
  }];
  let decisions;
  try {
    const r = await callLLM(apiKey, model, messages, {
      reasoning: { effort: 'low' }, maxTokens: 6000,
      responseFormat: { type: 'json_schema', json_schema: { name: 'cleanup', strict: true, schema: SCHEMA } },
    });
    decisions = parseFencedJson(r.choices?.[0]?.message?.content);
  } catch (e) { console.log('[name-cleaner] skipped:', e?.message); return report; }
  if (!decisions || !Array.isArray(decisions.items)) return report;
  const byI = new Map(decisions.items.map((d) => [d.i, d]));
  const kept = [];
  for (let i = 0; i < report.products.length; i++) {
    const d = byI.get(i);
    if (d && d.keep === false) continue; // explicit drop; missing decision → keep (fail-safe)
    const p = report.products[i];
    let name = p.name;
    if (d && typeof d.clean_name === 'string' && d.clean_name.trim()) {
      // GROUNDEDNESS GATE: every cleaned word must already exist in the original name.
      const orig = new Set(gNorm(name).split(' '));
      const clean = gNorm(d.clean_name).split(' ').filter((w) => w.length >= 2);
      if (clean.length && clean.every((w) => orig.has(w))) name = d.clean_name.trim();
    }
    kept.push({ ...p, name });
  }
  if (!kept.length) return report; // never empty the report on a bad LLM response
  console.log(`[name-cleaner] ${report.products.length} → ${kept.length} products`);
  report.products = kept.map((p, i) => ({ ...p, rank: i + 1 }));
  return report;
}
