// Full-coverage assertions for the pure helpers in research-primitives.js.
// freshnessLabel is the only helper with branching worth a dedicated suite —
// starMarkup/renderItemImage/resolveProductCtas already have coverage via
// reviews.test.js and the render-smoke suites.
import { freshnessLabel } from '../../worker/pages/research-primitives.js';
import { subscribeScript } from '../../worker/pages/research-scripts.js';

export function runResearchPrimitivesTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // Fixed "now" so day-boundary math is deterministic regardless of when the
  // suite runs. 2026-07-28T12:00:00Z.
  const nowMs = Date.UTC(2026, 6, 28, 12, 0, 0);
  const daysAgo = (n) => nowMs / 1000 - n * 86_400;

  eq('today (just under a day old)', freshnessLabel(daysAgo(0), nowMs), { text: 'today', isStale: false });
  eq('yesterday (exactly 1 day)', freshnessLabel(daysAgo(1), nowMs), { text: 'yesterday', isStale: false });
  eq('5 days ago', freshnessLabel(daysAgo(5), nowMs), { text: '5 days ago', isStale: false });
  eq('30 days ago: relative text, not stale', freshnessLabel(daysAgo(30), nowMs), { text: '30 days ago', isStale: false });
  eq('31 days ago: relative text, stale', freshnessLabel(daysAgo(31), nowMs), { text: '31 days ago', isStale: true });
  eq('59 days ago: still relative text', freshnessLabel(daysAgo(59), nowMs), { text: '59 days ago', isStale: true });
  eq('60 days ago: absolute month + year', freshnessLabel(daysAgo(60), nowMs), { text: 'May 2026', isStale: true });
  eq('null input → empty, not stale', freshnessLabel(null, nowMs), { text: '', isStale: false });
  eq('undefined input → empty, not stale', freshnessLabel(undefined, nowMs), { text: '', isStale: false });
  eq('string input → empty, not stale', freshnessLabel('1700000000', nowMs), { text: '', isStale: false });

  // subscribeScript defaults researchId to null when omitted (general/hub subscribe)
  eq('subscribeScript() without researchId embeds null', subscribeScript().includes('var researchId=null;'), true);
  eq('subscribeScript(id) embeds the report id', subscribeScript('abc12345def67890').includes('var researchId="abc12345def67890";'), true);

  return report;
}
