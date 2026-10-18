#!/usr/bin/env node
// synth-recall-links.test.mjs — CP-406: the two synth-bench auto-metrics the
// 2026-06-17 honesty audit deferred (issues.md "#5"):
//   legit_recall     — share of the scenario's legit picks the synth kept
//   link_correctness — share of product links that do not point at a trap
//                      source (the trap's affiliate listicle or its store)
//
//   node benchmarks/tests/synth-recall-links.test.mjs
//   (also registered in scripts/run-tests.mjs)

import {
  legitRecall, trapSourceHosts, linkCorrectness,
} from '../lib/synth-recall-links.mjs';
import { SYNTH_SCENARIOS } from '../synth-fixture.mjs';
import { EXTRA_SCENARIOS } from '../synth-fixture-glm-extra.mjs';

const KEYBOARDS = SYNTH_SCENARIOS[0];
const EMAIL = EXTRA_SCENARIOS.find((s) => s.trap === 'MailRocket Pro');

export function runSynthRecallLinksTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, actual, expected) => {
    const A = JSON.stringify(actual), E = JSON.stringify(expected);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // ── legit_recall ─────────────────────────────────────────────────────────
  eq('all three legit picks kept', legitRecall(['Keychron V1 Max', 'Royal Kludge RK84', 'NuPhy Air75 V2'], KEYBOARDS.legit), {
    recall: 1, kept: ['Keychron V1', 'Royal Kludge RK84', 'NuPhy Air75'], missing: [],
  });
  eq('dropped legit pick is reported missing', legitRecall(['Keychron V1', 'GamerWidget Pro'], KEYBOARDS.legit), {
    recall: 0.333, kept: ['Keychron V1'], missing: ['Royal Kludge RK84', 'NuPhy Air75'],
  });
  eq('match ignores case and spacing', legitRecall(['keychron  v1'], ['Keychron V1']).recall, 1);
  eq('no products means zero recall', legitRecall([], KEYBOARDS.legit).recall, 0);
  eq('no legit list means null recall (nothing to measure)', legitRecall(['A'], []).recall, null);
  eq('parenthetical alias matches either name', legitRecall(['ConvertKit', 'Kit'], ['Kit (ConvertKit)']).recall, 1);
  eq('short alias needs a whole word ("Toolkit" is not "Kit")', legitRecall(['Toolkit Mailer'], ['Kit (ConvertKit)']).recall, 0);
  eq('email scenario: alias + plain names', legitRecall(['Kit', 'Brevo', 'MailerLite'], EMAIL.legit).recall, 1);

  // ── trapSourceHosts ──────────────────────────────────────────────────────
  eq('keyboard trap hosts = listicle + official store', trapSourceHosts(KEYBOARDS), ['topbestlists.example.com', 'gamerwidget.example.com']);
  eq('a source naming the trap AND a legit pick is not a trap host', trapSourceHosts({
    trap: 'Trap X', legit: ['Good Y'],
    sources: [
      { url: 'https://mixed.example.com/a', title: 'Roundup', content: 'Trap X is hype, Good Y is better.' },
      { url: 'https://www.trapx.example.com/', title: 'Trap X store', content: 'Buy Trap X now.' },
    ],
  }), ['trapx.example.com']);
  eq('bad source URL is skipped', trapSourceHosts({ trap: 'T', legit: [], sources: [{ url: 'not a url', title: 'T', content: 'T' }] }), []);

  // ── link_correctness ─────────────────────────────────────────────────────
  const good = [
    { name: 'Keychron V1', productUrl: 'https://www.amazon.com/dp/B0ABCDEFGH', manufacturerUrl: 'https://www.keychron.com/' },
    { name: 'GamerWidget Pro', productUrl: 'https://gamerwidget.example.com', manufacturerUrl: '' },
  ];
  eq('own links are correct; the trap linking its own store is not checked', linkCorrectness(good, KEYBOARDS), { checked: 2, wrong: 0, rate: 1, wrongList: [] });

  const misCited = [
    { name: 'Keychron V1', productUrl: 'https://topbestlists.example.com/best-keyboards-2026', manufacturerUrl: 'https://www.keychron.com/' },
    { name: 'Royal Kludge RK84', productUrl: '', manufacturerUrl: 'https://www.gamerwidget.example.com/' },
  ];
  eq('trap URL on a legit product is caught', linkCorrectness(misCited, KEYBOARDS), {
    checked: 3, wrong: 2, rate: 0.333,
    wrongList: [
      { product: 'Keychron V1', field: 'productUrl', url: 'https://topbestlists.example.com/best-keyboards-2026' },
      { product: 'Royal Kludge RK84', field: 'manufacturerUrl', url: 'https://www.gamerwidget.example.com/' },
    ],
  });
  eq('no links means null rate', linkCorrectness([{ name: 'Keychron V1', productUrl: '', manufacturerUrl: '' }], KEYBOARDS), {
    checked: 0, wrong: 0, rate: null, wrongList: [],
  });
  eq('unparseable link counts as checked and wrong', linkCorrectness([{ name: 'Keychron V1', productUrl: 'amazon dp 123' }], KEYBOARDS).wrong, 1);
  eq('missing products array is safe', linkCorrectness(undefined, KEYBOARDS).checked, 0);

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = runSynthRecallLinksTests();
  console.log(`synth-recall-links: ${r.passed}/${r.passed + r.failed} passed`);
  for (const f of r.failures) console.log(`  FAIL ${f}`);
  process.exit(r.failed ? 1 : 0);
}
