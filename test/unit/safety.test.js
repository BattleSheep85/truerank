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

  // ── 9. CP-394: obfuscation bypasses (leetspeak, spacing, symbols, unicode) ──
  const cp394Blocked = [
    { q: 'free p0rn videos', reason: 'adult', desc: 'digit for letter' },
    { q: 'best s3x toys', reason: 'adult', desc: 'digit for letter in a phrase' },
    { q: 'best $ex toys', reason: 'adult', desc: 'symbol for letter' },
    { q: 'free p o r n sites', reason: 'adult', desc: 'spaced letters' },
    { q: 'free p.o.r.n sites', reason: 'adult', desc: 'dotted letters' },
    { q: 'free p-0-r-n videos', reason: 'adult', desc: 'dashes plus leetspeak' },
    { q: 'free p\u200Born videos', reason: 'adult', desc: 'zero-width space inside a word' },
    { q: 'free p\u00F6rn videos', reason: 'adult', desc: 'accented letter' },
    { q: 'free \u0440\u043Ern videos', reason: 'adult', desc: 'Cyrillic look-alike letters' },
    { q: 'free \uFF50\uFF4F\uFF52\uFF4E videos', reason: 'adult', desc: 'full-width letters' },
    { q: 'free pooorn videos', reason: 'adult', desc: 'stretched letters' },
    { q: 'watch h e n t a i online free', reason: 'adult', desc: 'spaced hentai' },
    { q: 'buy c0caine online', reason: 'illegal', desc: 'leetspeak drug name' },
    { q: 'where to buy h-e-r-o-i-n', reason: 'illegal', desc: 'dashed drug name' },
    { q: 'f3nt4nyl for sale', reason: 'illegal', desc: 'several digits for letters' },
    { q: 'how to make a b0mb at home', reason: 'illegal', desc: 'leetspeak weapon' },
    { q: 'how to h4ck someone instagram', reason: 'illegal', desc: 'leetspeak hacking' },
    { q: 'best 1oli manga', reason: 'illegal', desc: 'digit one for letter l' },
    { q: 'best p0rn! sites', reason: 'adult', desc: 'leetspeak plus trailing punctuation' },
    { q: 'free p0rn!', reason: 'adult', desc: 'leetspeak plus a final !' },
    { q: 'best h3ntai! manga', reason: 'adult', desc: 'leetspeak hentai plus !' },
    { q: 'best s3x+toys', reason: 'adult', desc: 'plus sign between words' },
    { q: 'buy c0caine@ home', reason: 'illegal', desc: 'trailing @' },
    { q: 'how to make a b o m b', reason: 'illegal', desc: 'spaced word after the word "a"' },
    { q: 'how to make a b-o-m-b', reason: 'illegal', desc: 'dashed word after the word "a"' },
    { q: 'buy a g u n illegally', reason: 'illegal', desc: 'spaced gun after the word "a"' },
  ];
  for (const { q, reason, desc } of cp394Blocked) {
    const res = screenQuery(q);
    eq(`CP-394 block (${desc}): "${q}"`, res.blocked, true);
    eq(`CP-394 reason (${desc}): "${q}"`, res.reason, reason);
  }

  const cp394Allowed = [
    'sony wh-1000xm5 vs bose qc ultra',
    'lg c3 vs samsung s90c oled tv',
    'best 4k monitor under $400',
    'sony a7 iv vs canon r6',
    'best laptop ornament for christmas',
    'nude lipstick for fair skin',
    'best usb c to usb a adapter',
    'ps5 vs xbox series x',
    'best rx 7900 xtx graphics card',
    'm4 macbook air 13 inch',
    'best 3d printer for beginners',
    'h 1 b visa lawyer near me',
    'best e bike for commuting',
    'best x t r a long phone cable',
    'best cocoa powder for baking',
    'best heroine fantasy novels',
  ];
  for (const q of cp394Allowed) {
    eq(`CP-394 still allow: "${q}"`, screenQuery(q).blocked, false);
  }

  return report;
}
