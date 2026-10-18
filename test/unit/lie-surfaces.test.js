// CP-407: honesty checks for three query shapes the fixtures never covered:
// comparative "X vs Y", a recalled/discontinued product, and a local place
// whose sources give no address. Runs the production synth (the deterministic
// extraction engine, SYNTH_ENGINE=extract) on the fixtures in
// benchmarks/synth-fixture-lie-surfaces.mjs. No LLM, no network.
//
// These pin LIES (invented or misattributed facts), not recall. A run that
// finds fewer products is a quality gap; a run that states something the
// sources do not say about a product is a lie.

import { synthesizeExtractive } from '../../worker/engine/extract/index.js';
import { analyzeProduct } from '../../worker/engine/extract/scoring.js';
import { validateResearchResult } from '../../worker/engine/validate.js';
import {
  COMPARATIVE_SCENARIO, RECALLED_SCENARIO, LOCATION_SCENARIO, LIE_SURFACE_SCENARIOS,
} from '../../benchmarks/synth-fixture-lie-surfaces.mjs';

const run = (sc) => synthesizeExtractive(sc.query, sc.notes, sc.sources, sc.facets, sc.topicalCategory);
const lower = (s) => String(s || '').toLowerCase();
const named = (report, name) => report.products.find((p) => lower(p.name).includes(lower(name)));
const allText = (report) => JSON.stringify(report);

// Every number in a product's price and specs must appear in some source as a
// whole number ("30" inside "300" does not count).
function ungroundedNumbers(report, sc) {
  const hay = sc.sources.map((s) => `${s.title} ${s.content}`).join(' ').replace(/,/g, '');
  const out = [];
  for (const p of report.products) {
    const nums = [p.price, ...Object.values(p.specs || {})].filter((v) => v != null).flatMap((v) => String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []);
    for (const n of nums) if (!new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}(?![\\d]|\\.\\d)`).test(hay)) out.push(`${p.name}: ${n}`);
  }
  return out;
}

// A street address or a US phone number, the two things a local report could invent.
const ADDRESS_RE = /\b\d{2,5}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Way|Hwy)\b/;
const PHONE_RE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;

export function runLieSurfaceTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const ok = (name, cond, detail = '') => {
    if (cond) report.passed++;
    else { report.failed++; report.failures.push(`${name}${detail ? `: ${detail}` : ''}`); }
  };

  // ── every scenario: no trap, no invented numbers, nothing off-source ──
  for (const sc of LIE_SURFACE_SCENARIOS) {
    const out = run(sc);
    const validated = out.products.length ? validateResearchResult(out, { query: sc.query, topicalCategory: sc.topicalCategory }) : out;
    ok(`${sc.query}: trap "${sc.trap}" never appears as a pick`, !named(out, sc.trap) && !named(validated, sc.trap));
    const bad = ungroundedNumbers(out, sc);
    ok(`${sc.query}: every price and spec number is in a source`, bad.length === 0, bad.join(', '));
    const hay = lower(sc.sources.map((s) => `${s.title} ${s.content}`).join(' ') + sc.notes.map((n) => n.content).join(' '));
    const offSource = out.products.filter((p) => !hay.includes(lower(p.name)));
    ok(`${sc.query}: every product name is in a source`, offSource.length === 0, offSource.map((p) => p.name).join(', '));
  }

  // ── comparative "X vs Y" ──
  const cmp = run(COMPARATIVE_SCENARIO);
  const sony = named(cmp, 'Sony WH-1000XM6');
  const bose = named(cmp, 'Bose QuietComfort Ultra');
  ok('comparative: both X and Y are in the report', !!sony && !!bose);
  ok('comparative: no third product is invented', cmp.products.length === 2, cmp.products.map((p) => p.name).join(', '));
  // The source says "Sony ... about 30 hours ... versus 24 hours for the Bose".
  ok('comparative: Sony keeps its own 30-hour battery figure', sony?.specs?.hours === '30 hours', JSON.stringify(sony?.specs));
  ok('comparative: Bose is not given Sony\'s 30-hour figure', bose?.specs?.hours !== '30 hours', JSON.stringify(bose?.specs));
  ok('comparative: Bose gets its own 24-hour figure', bose?.specs?.hours === '24 hours', JSON.stringify(bose?.specs));

  // ── recalled / discontinued ──
  const recalled = run(RECALLED_SCENARIO);
  const graco = named(recalled, RECALLED_SCENARIO.recalled);
  ok('recalled: the synth still returns picks (so the checks below test something)', recalled.products.length >= 1);
  ok('recalled: the recalled seat is never ranked first', lower(recalled.products[0]?.name) !== lower(RECALLED_SCENARIO.recalled));
  ok('recalled: if the recalled seat is listed, a con names the recall',
    !graco || graco.cons.some((c) => /recall|discontinu/i.test(c)), JSON.stringify(graco?.cons));
  ok('recalled: no pro calls the recalled seat safe or recommended',
    !graco || !graco.pros.some((p) => /\b(safe|safest|recommend)/i.test(p)));

  // ── location with no address in the sources ──
  const loc = run(LOCATION_SCENARIO);
  ok('location: no street address is invented', !ADDRESS_RE.test(allText(loc)), allText(loc).match(ADDRESS_RE)?.[0]);
  ok('location: no phone number is invented', !PHONE_RE.test(allText(loc)), allText(loc).match(PHONE_RE)?.[0]);
  ok('location: no product carries address or phone metadata',
    loc.products.every((p) => !Object.keys(p.metadata || {}).some((k) => /address|phone|location|hours/i.test(k))));

  // ── analyzeProduct attribution, unit level ──
  // A price or spec in a sentence that names a rival belongs to the product
  // named nearest to it, not to every product the source mentions.
  const src = (content) => ({ title: 'Lab test', content, credibility: { score: 90, tags: ['hands-on'] } });
  const cand = (name) => ({ name, toks: name.split(' '), sents: [] });
  const two = [src('The Alpha One costs $199 and weighs 250 g. The Beta Two costs $349 and lasts 40 hours.')];
  const alpha = analyzeProduct(cand('Alpha One'), two, ['beta two']);
  const beta = analyzeProduct(cand('Beta Two'), two, ['alpha one']);
  ok('attribution: Alpha One gets $199, not $349', alpha.price === 199, String(alpha.price));
  ok('attribution: Beta Two gets $349, not $199', beta.price === 349, String(beta.price));
  ok('attribution: Alpha One does not get Beta Two\'s 40 hours', !alpha.specs.hours, JSON.stringify(alpha.specs));
  ok('attribution: Beta Two keeps its 40 hours', beta.specs.hours === '40 hours', JSON.stringify(beta.specs));
  // A single-product source keeps the old behavior: a later sentence that names
  // no product ("It lasts 30 hours") still counts for the one product it covers.
  const solo = analyzeProduct(cand('Alpha One'), [src('The Alpha One is our pick. It costs $199. It lasts 30 hours.')], ['beta two']);
  ok('attribution: a single-product source keeps unnamed-sentence facts', solo.price === 199 && solo.specs.hours === '30 hours', JSON.stringify(solo));

  // Overlapping names: the longer name owns its mention.
  const pods = [src('For $249 you get the AirPods Pro 2. The AirPods Pro cost $199 at launch.')];
  const pro = analyzeProduct(cand('AirPods Pro'), pods, ['airpods pro 2']);
  const pro2 = analyzeProduct(cand('AirPods Pro 2'), pods, ['airpods pro']);
  ok('overlap: AirPods Pro does not take AirPods Pro 2\'s $249', pro.price === 199, String(pro.price));
  ok('overlap: AirPods Pro 2 keeps $249', pro2.price === 249, String(pro2.price));
  const qc = analyzeProduct(cand('Bose QuietComfort Ultra'), [src('The Bose QuietComfort Ultra lasts 24 hours per charge.')], ['bose quietcomfort', 'sony wh-1000xm6']);
  ok('overlap: a shorter rival name inside this name is not a rival mention', qc.specs.hours === '24 hours', JSON.stringify(qc.specs));

  // A rival model code that is the number itself ("600" in "600 nits") is not a mention.
  const panel = analyzeProduct(cand('Sony Bravia 9'), [src('The Sony Bravia 9 hits 600 nits in our test, while the Sennheiser HD 600 is a headphone.')], ['sennheiser hd 600', '600']);
  ok('model code: "600 nits" stays with Sony Bravia 9', panel.specs.nits === '600 nits', JSON.stringify(panel.specs));

  // A review page about one product keeps its pronoun facts despite a passing rival mention.
  const review = { title: 'Gaggia Classic Pro review', content: 'The Gaggia Classic Pro is our pick. It costs $449. It weighs 9 kg. Unlike the Breville Bambino, it has a commercial portafilter.', credibility: { score: 90, tags: ['hands-on'] } };
  const gaggia = analyzeProduct(cand('Gaggia Classic Pro'), [review], ['breville bambino']);
  const bambino = analyzeProduct(cand('Breville Bambino'), [review], ['gaggia classic pro']);
  ok('subject page: the reviewed product keeps "It costs $449"', gaggia.price === 449 && gaggia.specs.kg === '9 kg', JSON.stringify({ price: gaggia.price, specs: gaggia.specs }));
  ok('subject page: the passing rival gets none of it', bambino.price === null && !bambino.specs.kg, JSON.stringify({ price: bambino.price, specs: bambino.specs }));

  return report;
}
