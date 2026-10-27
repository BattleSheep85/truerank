// CP-429: research.result is a JSON contract between the writer
// (persistEngineResult in worker/pipeline/orchestrator.js) and the readers
// (worker/handlers/report.js, research.js, chat.js, worker/pages/research-page.js).
// docs/research-result-schema.md describes it; this suite checks real synth
// outputs, run through the same validate + persist steps, still match it.

import { readFileSync } from 'node:fs';
import { validateResearchResult } from '../../worker/engine/validate.js';

const isStr = (v) => typeof v === 'string';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isNumOrNull = (v) => v === null || isNum(v);
const isStrArray = (v) => Array.isArray(v) && v.every(isStr);
const isStrRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isStr);

// The schema from docs/research-result-schema.md, as checks. Keep both in step.
export const RESULT_FIELDS = {
  summary: isStr,
  category: isStr,
  methodology: isStr,
  products: Array.isArray,
  query: isStr,
  source_count: isNum,
  filtered_count: isNum,
};
export const OPTIONAL_RESULT_FIELDS = {
  buyersGuide: (g) => !!g && isStr(g.howToChoose) && isStrArray(g.pitfalls) && isStrArray(g.marketingToIgnore),
};
export const PRODUCT_FIELDS = {
  name: isStr,
  brand: isStr,
  price: isNumOrNull,
  rating: (v) => v === null || (isNum(v) && v >= 0 && v <= 5),
  productUrl: isStr,
  manufacturerUrl: isStr,
  imageUrl: isStr,
  pros: isStrArray,
  cons: isStrArray,
  specs: isStrRecord,
  metadata: isStrRecord,
  verdict: isStr,
  rank: isNum,
  bestFor: isStr,
};
const isCriticalReview = (r) => !!r && isStr(r.quote) && isNum(r.stars) && r.stars >= 1 && r.stars <= 2
  && isStr(r.sourceUrl) && r.sourceUrl.startsWith('https://') && isStr(r.sourceTitle);
// criticalReviews (CP-399) is optional: rows written before it have none.
export const OPTIONAL_PRODUCT_FIELDS = { affiliateUrl: isStr, criticalReviews: (v) => Array.isArray(v) && v.every(isCriticalReview) };

function checkFields(obj, required, optional, where) {
  const problems = [];
  for (const [key, ok] of Object.entries(required)) {
    if (!(key in obj)) problems.push(`${where}: missing ${key}`);
    else if (!ok(obj[key])) problems.push(`${where}: bad ${key}=${JSON.stringify(obj[key])?.slice(0, 60)}`);
  }
  for (const key of Object.keys(obj)) {
    if (key in required) continue;
    if (!(key in optional)) problems.push(`${where}: undocumented ${key}`);
    else if (!optional[key](obj[key])) problems.push(`${where}: bad ${key}`);
  }
  return problems;
}

export function checkResearchResult(result) {
  if (!result || typeof result !== 'object') return ['result is not an object'];
  const problems = checkFields(result, RESULT_FIELDS, OPTIONAL_RESULT_FIELDS, 'result');
  (Array.isArray(result.products) ? result.products : []).forEach((p, i) => {
    problems.push(...checkFields(p, PRODUCT_FIELDS, OPTIONAL_PRODUCT_FIELDS, `products[${i}]`));
  });
  return problems;
}

// What persistEngineResult stores: the validated result plus three fields.
function persistShape(validated, query, sourceCount) {
  return { ...validated, query, source_count: sourceCount, filtered_count: 0 };
}

// Real synth outputs (kimi, glm, opus) from the committed GLM bench raw file.
function realOutputs() {
  const raw = JSON.parse(readFileSync(new URL('../../benchmarks/results/glm52-synth-raw-fixedv2.json', import.meta.url), 'utf8'));
  return raw.rows.flatMap((row) => row.runs.filter((r) => r.output).map((r) => ({ label: row.label, query: r.query, output: r.output })));
}

export function runResearchResultShapeTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const ok = (name, cond, detail = '') => {
    if (cond) report.passed++;
    else { report.failed++; report.failures.push(`${name}${detail ? `: ${detail}` : ''}`); }
  };

  const outputs = realOutputs();
  ok('bench file has real synth outputs', outputs.length >= 12, `got ${outputs.length}`);

  for (const { label, query, output } of outputs) {
    const stored = persistShape(validateResearchResult(output, { query }), query, 7);
    const problems = checkResearchResult(stored);
    ok(`real result matches schema (${label} / ${query})`, problems.length === 0, problems.slice(0, 3).join('; '));
    ok(`real result has products (${label} / ${query})`, stored.products.length >= 1);
  }

  // The ASIN resolver adds affiliateUrl to products it resolves; still valid.
  const [first] = outputs;
  const resolved = persistShape(validateResearchResult(first.output, { query: first.query }), first.query, 3);
  resolved.products = resolved.products.map((p, i) => (i === 0 ? { ...p, productUrl: 'https://www.amazon.com/dp/B000000000', affiliateUrl: 'https://www.amazon.com/dp/B000000000?tag=x-20' } : p));
  ok('affiliateUrl from the ASIN resolver is allowed', checkResearchResult(resolved).length === 0);

  // A minimal synth answer (no guide, sloppy product) still fits the schema.
  const minimal = persistShape(validateResearchResult({
    summary: 'Short honest summary.',
    products: [{ name: 'Widget', pros: ['works'], verdict: 'Fine for light use at home.', specs: { weight: 2.5 } }],
  }), 'widget', 0);
  ok('minimal result matches schema', checkResearchResult(minimal).length === 0, checkResearchResult(minimal).join('; '));
  ok('minimal result has no buyersGuide key', !('buyersGuide' in minimal));
  ok('specs numbers are coerced to strings', minimal.products[0].specs.weight === '2.5');

  // The checker itself catches drift.
  ok('checker flags a missing field', checkResearchResult({ ...minimal, summary: undefined }).length > 0);
  ok('checker flags an undocumented field', checkResearchResult({ ...minimal, surprise: 1 }).some((p) => p.includes('undocumented surprise')));
  ok('checker flags a bad product rating', checkResearchResult({ ...minimal, products: [{ ...minimal.products[0], rating: 9 }] }).length > 0);

  return report;
}
