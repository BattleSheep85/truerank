// CP-421: a homepage search opens the server-rendered processing page (/research/<slug>)
// as soon as the run is queued, instead of the bare text log on the homepage.
// Runs the real public/js/app.js in a stubbed browser (node:vm, no dependencies).
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP_JS = readFileSync(new URL('../../public/js/app.js', import.meta.url), 'utf8');

function runHomeSearch(researchResponse) {
  const calls = { fetch: [], eventSources: 0, history: [], progress: [] };
  let submit = null;
  const input = { value: 'best linen shirts', disabled: false };
  const form = {
    addEventListener: (type, fn) => { if (type === 'submit') submit = fn; },
    querySelector: (sel) => (sel === 'input[name="query"]' ? input : null),
  };
  const progressLog = { appendChild: (el) => calls.progress.push(el.textContent), innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  const document = {
    querySelectorAll: (sel) => (sel === 'form.search-form' ? [form] : []),
    getElementById: (id) => (id === 'progress-log' ? progressLog : null),
    createElement: () => ({ className: '', textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: { classList: { contains: () => false, toggle: () => {} } },
  };
  const json = (body) => Promise.resolve({ headers: { get: () => 'application/json' }, json: () => Promise.resolve(body) });
  const window = {
    location: { href: '', search: '' },
    matchMedia: () => ({ matches: true }),
    addEventListener: () => {},
    TrueRankHistory: { record: (slug, q) => calls.history.push([slug, q]) },
  };
  const sandbox = {
    window, document, URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: (url) => {
      calls.fetch.push(url);
      if (url === '/api/classify') return json({ accept: true, clarifying_questions: [] });
      if (url === '/api/research') return json(researchResponse);
      return json({});
    },
    EventSource: function () { calls.eventSources++; this.close = () => {}; },
    setTimeout: () => 0,
    console,
  };
  sandbox.TrueRankHistory = window.TrueRankHistory;
  vm.runInNewContext(APP_JS, sandbox);
  submit({ preventDefault: () => {} });
  return new Promise((resolve) => setImmediate(() => setImmediate(() => resolve({ calls, window }))));
}

export async function runHomeSearchRouteTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  const queued = await runHomeSearch({ id: 'r1', slug: 'best-linen-shirts', status: 'pending' });
  eq('CP-421 queued run opens the processing page', queued.window.location.href, '/research/best-linen-shirts');
  eq('CP-421 no homepage live log (no EventSource)', queued.calls.eventSources, 0);
  eq('CP-421 no homepage polling', queued.calls.fetch.filter((u) => u.startsWith('/api/research/')).length, 0);
  eq('CP-421 the search is saved to history', queued.calls.history, [['best-linen-shirts', 'best linen shirts']]);

  const cached = await runHomeSearch({ id: 'r2', slug: 'best-linen-shirts', cached: true });
  eq('cached research still opens its page', cached.window.location.href, '/research/best-linen-shirts');

  const noSlug = await runHomeSearch({ id: 'r3', status: 'pending' });
  eq('without a slug the homepage log stays as a fallback', [noSlug.window.location.href, noSlug.calls.eventSources], ['', 1]);

  const failed = await runHomeSearch({ error: 'Monthly budget reached' });
  eq('an error does not navigate', failed.window.location.href, '');

  return report;
}
