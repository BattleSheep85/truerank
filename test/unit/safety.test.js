// Table-driven unit tests for worker/lib/safety.js
import { screenQuery, rejectionMessage, isProbeQuery } from '../../worker/lib/safety.js';

export function runSafetyTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── 1. Genuine shopping queries (must ALL pass without being blocked) ───────────
  const genuineQueries = [
    'best 4k monitor under $400',
    'sony wh-1000xm5 vs bose qc ultra',
    'best mechanical keyboard under 150',
    'apple macbook air m3',
    'running shoes for wide feet',
    'best system prompt manager for teams',
    'best earplugs to ignore loud coworkers',
    'best laptop, ignore the previous model please',
    'best android phone with developer mode',
    'dji mini 4 pro drone bundle',
    'lg c3 vs samsung s90c oled tv',
    'instant pot duo plus 9-in-1 pressure cooker',
    'synology ds224+ vs qnap ts-264 nas',
    'bose quietcomfort 45 headphones',
    'best budget cordless vacuum for pet hair',
    'logitech mx master 3s wireless mouse',
  ];

  for (const q of genuineQueries) {
    const res = screenQuery(q);
    eq(`allow genuine query: "${q}"`, res.blocked, false);
    eq(`isProbeQuery returns false for: "${q}"`, isProbeQuery(q), false);
  }

  // ── 2. Real SQL injection scanner probes from audit (must ALL be blocked) ─────
  const auditProbeQueries = [
    'best tax software for self employed and 9323 UTL_INADDR.GET_HOST_ADDRESS(CHR(113)||CHR(118))',
    'best headphones\' UNION SELECT 1,2,3,version()--',
    'best laptop\' AND (SELECT 1 FROM (SELECT(SLEEP(5)))a)--',
    'running shoes\'; WAITFOR DELAY \'0:0:5\'--',
    'gaming mouse\' AND 1=1 AND (SELECT count(*) FROM information_schema.tables)--',
  ];

  for (const q of auditProbeQueries) {
    const res = screenQuery(q);
    eq(`block audit probe query: "${q}"`, res.blocked, true);
    eq(`reason is probe for: "${q}"`, res.reason, 'probe');
  }

  // ── 3. Additional scanner and attack signals (must ALL be blocked) ──────────
  const otherProbeQueries = [
    { q: 'https://example.com/some/long/url', desc: 'whole URL query' },
    { q: 'http://foo.com/bar', desc: 'http whole URL query' },
    { q: '<script>alert(1)</script>', desc: 'script tag' },
    { q: 'best tv <img src=x onerror=alert(1)>', desc: 'HTML tag injection' },
    { q: 'javascript:alert(document.cookie)', desc: 'javascript scheme' },
    { q: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==', desc: 'data scheme' },
    { q: 'wireless earbuds BENCHMARK(5000000,MD5(1))', desc: 'SQL BENCHMARK' },
    { q: 'best keyboard DBMS_PIPE.RECEIVE_MESSAGE(CHR(65),5)', desc: 'Oracle DBMS_PIPE' },
    { q: 'best router xp_cmdshell(\'dir\')', desc: 'MSSQL xp_cmdshell' },
    { q: 'best-tax-software-for-self-employed-and-9323-utl-inaddr-get-host-address-chr-113-4g0k1i0o', desc: 'run of 25+ non-space chars' },
    { q: 'query with (a) [b] {c} <d>', desc: 'more than 3 special chars ()[]{};|<>' },
    { q: 'a 1 2', desc: 'nonsense ratio (fewer than 2 words of 3+ letters)' },
    { q: 'xyz', desc: 'single word of 3 letters (fewer than 2 word tokens)' },
  ];

  for (const { q, desc } of otherProbeQueries) {
    const res = screenQuery(q);
    eq(`block probe (${desc}): "${q}"`, res.blocked, true);
    eq(`probe reason for (${desc})`, res.reason, 'probe');
  }

  // ── 4. Adult and illegal patterns still blocked ────────────────────────────
  eq('adult query blocked', screenQuery('free porn videos hd').reason, 'adult');
  eq('illegal query blocked', screenQuery('how to make counterfeit money').reason, 'illegal');

  // ── 5. Empty query allowed (fail-safe for empty checks) ─────────────────────
  eq('empty query not blocked', screenQuery('').blocked, false);

  // ── 6. Rejection messages ──────────────────────────────────────────────────
  ok('rejection message for adult', rejectionMessage('adult').includes('adult'));
  ok('rejection message for illegal', rejectionMessage('illegal').includes('illegal'));
  ok('rejection message for probe', rejectionMessage('probe').includes('code') || rejectionMessage('probe').includes('scanner'));

  // ── 7. Verify mode URL handling ───────────────────────────────────────────
  const bareProductUrl = 'https://www.sony.com/wh-1000xm5';
  eq('bare product URL is blocked in research mode (default)', screenQuery(bareProductUrl).blocked, true);
  eq('bare product URL is blocked in research mode (explicit allowUrl: false)', screenQuery(bareProductUrl, { allowUrl: false }).blocked, true);
  eq('bare product URL passes in verify mode (allowUrl: true)', screenQuery(bareProductUrl, { allowUrl: true }).blocked, false);
  eq('isProbeQuery is true for bare URL in default mode', isProbeQuery(bareProductUrl), true);
  eq('isProbeQuery is false for bare URL with allowUrl: true', isProbeQuery(bareProductUrl, { allowUrl: true }), false);
  eq('probe URL with script tag is still blocked in verify mode', screenQuery('https://example.com/<script>alert(1)</script>', { allowUrl: true }).blocked, true);
  eq('probe URL with SQL payload is still blocked in verify mode', screenQuery('https://example.com/UNION SELECT 1,2,3', { allowUrl: true }).blocked, true);
  eq('javascript scheme is still blocked in verify mode', screenQuery('javascript:alert(1)', { allowUrl: true }).blocked, true);

  // ── 8. CP-723: short product names with a 2-char model number ─────────────
  eq('CP-723 allow short product name: "Antec C8"', screenQuery('Antec C8').blocked, false);
  eq('CP-723 allow short product name: "Sony A7"', screenQuery('Sony A7').blocked, false);
  eq('CP-723 allow short product name in verify mode: "Antec C8"', screenQuery('Antec C8', { allowUrl: true }).blocked, false);

  const cp723ProbeQueries = [
    { q: 'a 1 2', desc: 'single-char tokens only' },
    { q: 'C8', desc: 'lone 2-char model token' },
    { q: 'x1', desc: 'lone 2-char model token' },
    { q: 'ab 12', desc: 'letters-only and digits-only short tokens' },
  ];

  for (const { q, desc } of cp723ProbeQueries) {
    const res = screenQuery(q);
    eq(`CP-723 still block probe (${desc}): "${q}"`, res.blocked, true);
    eq(`CP-723 probe reason for (${desc}): "${q}"`, res.reason, 'probe');
  }

  return report;
}
