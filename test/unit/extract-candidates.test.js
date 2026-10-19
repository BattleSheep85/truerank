// Unit tests for the extraction harvester (worker/engine/extract/candidates.js).
import { harvestCandidates, resolveCandidates } from '../../worker/engine/extract/candidates.js';

const src = (content) => ({ title: 'Guide', content });
const names = (sentences, opts = {}) =>
  resolveCandidates(harvestCandidates(sentences.map(src), [], opts)).map((c) => c.name).sort();
const find = (sentences, name, opts = {}) =>
  resolveCandidates(harvestCandidates(sentences.map(src), [], opts)).find((c) => c.name === name);

export function runExtractCandidatesTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // ── CP-395: two neighbor products harvested as one candidate ─────────────
  const photo = [
    'Synology Photos Immich and PhotoPrism are the top self-hosted picks.',
    'Synology Photos works well on a DS224 for families.',
    'Immich has the best mobile app of the open source options.',
  ];
  const photoOpts = { extraNames: ['Immich'] };
  const photoNames = names(photo, photoOpts);
  eq('CP-395 merged "Synology Photos Immich" is split', photoNames.includes('Synology Photos Immich'), false);
  eq('CP-395 keeps "Synology Photos"', photoNames.includes('Synology Photos'), true);
  eq('CP-395 keeps "Immich"', photoNames.includes('Immich'), true);
  const immich = find(photo, 'Immich', photoOpts);
  eq('CP-395 the merged sentence goes to Immich too', !!immich?.sents.some((s) => /PhotoPrism/.test(s.sentence)), true);
  const syn = find(photo, 'Synology Photos', photoOpts);
  eq('CP-395 the merged sentence goes to Synology Photos too', !!syn?.sents.some((s) => /PhotoPrism/.test(s.sentence)), true);

  // No split when a part has no mention of its own (it only exists inside the merge).
  const onlyMerged = ['Synology Photos Immich is what most people pick.'];
  eq('CP-395 no split without independent mentions',
    names(onlyMerged, { extraNames: ['Immich'] }).includes('Synology Photos Immich'), true);

  // No split of a real multi-word product name.
  const breville = [
    'The Breville Barista Express is the best starter machine.',
    'Breville Barista machines are popular.',
    'Express shipping is free.',
  ];
  eq('CP-395 keeps "Breville Barista Express"', names(breville).includes('Breville Barista Express'), true);

  // No split after a bare brand ("Sony" + "WH-1000XM5" is one product).
  const sony = [
    'The Sony WH-1000XM5 is the best noise cancelling headphone.',
    'Sony makes great headphones.',
    'The WH-1000XM5 has 30 hours of battery.',
  ];
  eq('CP-395 keeps "Sony WH-1000XM5"', names(sony).includes('Sony WH-1000XM5'), true);

  // No split of a name that carries a model code (brandTruncate owns those).
  const nas = [
    'The Synology DiskStation DS224 is quiet.',
    'Synology DiskStation is the software.',
  ];
  eq('CP-395 keeps a name with a model code', names(nas).includes('Synology DiskStation DS224'), true);

  return report;
}
