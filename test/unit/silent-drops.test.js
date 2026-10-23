// CP-812: two drops that used to leave no log line.
// (a) proposeMissingLeaders gets model JSON it cannot parse.
// (b) the verify result page drops malformed evidence items.
import { proposeMissingLeaders } from '../../worker/engine/extract/recall-supplement.js';
import { renderVerifyResultPage } from '../../worker/pages/verify-page.js';

// Run fn with console.log / console.warn captured. Returns the lines.
async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, warn: console.warn };
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
  }
  return lines;
}

// A chat completion reply that holds `content`.
function chatReply(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}

async function withFetch(stub, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

function verifyEnv(result) {
  const row = {
    id: 'r1', slug: 'acme-x1-abcd1234', kind: 'verification', status: 'complete',
    query: 'Acme X1', summary: 'Acme X1', subject_url: 'https://acme.example/x1',
    overall_verdict: 'Mostly holds up', overall_score: 60,
    result: JSON.stringify(result), created_at: 1700000000, completed_at: 1700000100,
  };
  const stmt = { bind() { return stmt; }, async first() { return row; }, async all() { return { results: [] }; } };
  return { DB: { prepare() { return stmt; } } };
}

const GOOD_EVIDENCE = { url: 'https://lab.example/x1', domain: 'lab.example', title: 'Lab test', span: 'Measured 30 hours.', credibility: 80, independence: 90 };

export async function runSilentDropsTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const ok = (name, cond) => { if (cond) report.passed++; else { report.failed++; report.failures.push(name); } };
  const sources = [{ title: 'Best widgets 2026' }];

  // (a) Unparseable model JSON: still [] for the caller, and one "skipped" line.
  let names;
  const badLines = await captureLogs(() => withFetch(async () => chatReply('not json at all'), async () => {
    names = await proposeMissingLeaders('best widget', 'widgets', ['Acme X1'], sources, 'test-key', 'test/model');
  }));
  ok('recall-supplement: unparseable JSON returns []', Array.isArray(names) && names.length === 0);
  // CP-819: the shared parser logs the drop once; the caller adds no second line.
  ok('recall-supplement: unparseable JSON is logged once by the parser',
    badLines.filter((l) => l.includes('[llm-json]') && l.includes('recall-supplement')).length === 1);
  ok('recall-supplement: no duplicate caller line for unparseable JSON', !badLines.some((l) => l.includes('could not be parsed')));

  // Parsed JSON of the wrong shape is dropped with a line too.
  const shapeLines = await captureLogs(() => withFetch(async () => chatReply('{"products":["Bolt Z9"]}'), async () => {
    names = await proposeMissingLeaders('best widget', 'widgets', ['Acme X1'], sources, 'test-key', 'test/model');
  }));
  ok('recall-supplement: wrong-shape JSON returns []', Array.isArray(names) && names.length === 0);
  ok('recall-supplement: wrong-shape JSON logs "skipped"', shapeLines.some((l) => l.includes('[recall-supplement] skipped')));

  // A good reply logs no "skipped" line.
  const goodLines = await captureLogs(() => withFetch(async () => chatReply('{"missing":["Bolt Z9"]}'), async () => {
    names = await proposeMissingLeaders('best widget', 'widgets', ['Acme X1'], sources, 'test-key', 'test/model');
  }));
  ok('recall-supplement: good JSON returns the names', JSON.stringify(names) === '["Bolt Z9"]');
  ok('recall-supplement: good JSON logs no "skipped"', !goodLines.some((l) => l.includes('[recall-supplement] skipped')));

  // (b) Malformed evidence items are dropped with one log line.
  const claim = (supporting, contradicting) => ({
    id: 'c1', text: 'Battery lasts 30 hours', category: 'battery', status: 'verified', supporting, contradicting,
  });
  const dropLines = await captureLogs(() => renderVerifyResultPage('acme-x1-abcd1234',
    verifyEnv({ claims: [claim([GOOD_EVIDENCE, null, 'text', [1]], 'not a list')], evidenceCount: 1 })));
  const dropLine = dropLines.find((l) => l.includes('[verify-page] dropped malformed evidence'));
  ok('verify-page: malformed evidence logs one line', Boolean(dropLine));
  ok('verify-page: the line names the slug', Boolean(dropLine) && dropLine.includes('acme-x1-abcd1234'));
  ok('verify-page: the line counts the dropped items', Boolean(dropLine) && dropLine.includes('"dropped":4'));

  const cleanLines = await captureLogs(() => renderVerifyResultPage('acme-x1-abcd1234',
    verifyEnv({ claims: [claim([GOOD_EVIDENCE], [])], evidenceCount: 1 })));
  ok('verify-page: clean evidence logs nothing', !cleanLines.some((l) => l.includes('[verify-page] dropped')));

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runSilentDropsTests();
  console.log(`silent-drops: ${r.passed}/${r.passed + r.failed} passed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.error('  FAIL', f);
    process.exit(1);
  }
}
