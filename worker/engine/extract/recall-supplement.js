// Recall supplement — the engine-shootout-v2 "C win", made honest. The ML harvest is
// comprehensive on Title-Case product mentions but MISSES the category's real leaders when they
// appear lowercase, in prose, or as a bare brand the KEEP rule filters (Immich/PhotoPrism for
// self-hosted photos; nothing for linen). This asks an LLM — which KNOWS a category's best
// options — to name the leaders MISSING from the current list. It only proposes NAMES; the
// engine then seeds them into harvestCandidates, so a proposed name survives ONLY if it actually
// appears in the gathered sources AND analyzeProduct finds credible evidence for it. The LLM can
// widen recall but can NEVER fabricate a product into the report. Proposes, never asserts.
import { callLLM } from '../llm.js';
import { routeHasKey } from '../../lib/llm-route.js';
import { parseFencedJson } from '../../lib/llm-json.js';

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['missing'],
  properties: { missing: { type: 'array', items: { type: 'string' }, maxItems: 12 } },
};

export async function proposeMissingLeaders(query, topicalCategory, existingNames, sources, apiKey, model) {
  if (!routeHasKey(apiKey) || !model || !Array.isArray(sources) || sources.length === 0) return [];
  // Source TITLES give the model grounding context (what these pages actually discuss) without
  // shipping full bodies. The hard grounding gate is downstream (the name must appear in a source).
  const titles = sources.map((s) => String(s?.title || '').trim()).filter(Boolean).slice(0, 40).join('\n');
  const have = (existingNames || []).join(', ') || '(none)';
  const messages = [{
    role: 'user',
    content: `Query: "${query}" — category: "${topicalCategory || ''}".
Current shortlist already extracted: ${have}.

These review sources were gathered for this query (titles):
${titles}

Name the SPECIFIC products that are genuinely among the best / most-recommended "${topicalCategory || 'options'}" for THIS query but are MISSING from the current shortlist. Rules:
- Real, specific product names (brand + model where it exists), NOT categories, platforms, or generic phrases.
- Only ones a knowledgeable buyer would expect to see for this exact query — especially strong picks that listicles under-cover (open-source/self-hosted tools, enthusiast/pro favorites, niche leaders).
- Use the name as it would literally appear in a review (so it can be matched against the sources).
- If the shortlist already looks complete, return an empty list. Do not pad.
Return JSON {"missing": [name, ...]}, at most 12.`,
  }];
  try {
    const r = await callLLM(apiKey, model, messages, {
      reasoning: { effort: 'low' }, maxTokens: 2000,
      responseFormat: { type: 'json_schema', json_schema: { name: 'recall', strict: true, schema: SCHEMA } },
    });
    const raw = parseFencedJson(r.choices?.[0]?.message?.content);
    const out = Array.isArray(raw?.missing) ? raw.missing : [];
    return out.map((s) => String(s || '').trim()).filter((s) => s.length >= 3).slice(0, 12);
  } catch (e) { console.log('[recall-supplement] skipped:', e?.message); return []; }
}
