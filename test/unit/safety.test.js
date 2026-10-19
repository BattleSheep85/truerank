// Table-driven unit tests for worker/lib/safety.js
import { screenQuery, rejectionMessage, isProbeQuery } from '../../worker/lib/safety.js';
import { CLASSIFIER_SYSTEM_PROMPT } from '../../worker/lib/classifier.js';

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

  // ── 10. CP-803: normal searches the screen blocked by mistake ────────────────
  const cp803Allowed = [
    'fentanyl test strips',
    'buy fentanyl test strips',
    'best fentanyl test kit',
    'test strips for fentanyl',
    'fentanyl drug test strips',
    'best drug test kit for fentanyl',
    'fentanyl test strip 100 pack',
    'buy a tv',
    'sony a 7 iv',
    'canon r 6',
    'a v receiver',
    'i 9 laptop',
    'nikon z 5',
    'tv stand',
    'iphone 16',
    'pixel 9',
  ];
  for (const q of cp803Allowed) {
    eq(`CP-803 allow: "${q}"`, screenQuery(q).blocked, false);
  }
  // The LLM classifier is the second layer; its prompt must not reject test strips as "drugs".
  eq('CP-803 classifier allows drug-checking kits', CLASSIFIER_SYSTEM_PROMPT.includes('"fentanyl test strips"'), true);

  const cp803Blocked = [
    { q: 'buy fentanyl online', reason: 'illegal' },
    { q: 'fentanyl test strips and where to buy fentanyl', reason: 'illegal' },
    { q: 'f3nt4nyl for sale', reason: 'illegal' },
    { q: 'heroin for sale', reason: 'illegal' },
    { q: 'buy illegal drugs test kits', reason: 'illegal' },
    { q: 'fentanyl test strips for sale and fentanyl', reason: 'illegal' },
    { q: 'a b', reason: 'probe' },
    { q: 'tv 4', reason: 'probe' },
  ];
  for (const { q, reason } of cp803Blocked) {
    eq(`CP-803 still block: "${q}"`, screenQuery(q).reason, reason);
  }

  // ── 11. CP-803: SQL-injection probes that became a public page (and close cousins) ──
  const cp803Probes = [
    "best tax software for self employed)) and extractvalue(6920,concat(0x5c,0x71706a7171,(select (elt(6920=6920,1))),0x7162706271)) and ((8923=8923",
    "best tax software for self employed) and extractvalue(6920,concat(0x5c,0x71706a7171,(select (elt(6920=6920,1))),0x7162706271))-- shca",
    'best tax software and extractvalue(1, concat(0x5c, user()))',
    'best tax software and updatexml(1, concat(0x7e, version()), 1)',
    "best tv' or 1=1--",
    'best tv and 1=1',
    "best laptop' and 'a'='a",
    'best monitor or 8923=8923',
    "best mouse' /* probe",
    'best router and load_file(0x2f6574632f706173737764)',
  ];
  for (const q of cp803Probes) {
    eq(`CP-803 block SQL probe: "${q.slice(0, 60)}"`, screenQuery(q).reason, 'probe');
  }
  for (const q of ['best 2 in 1 laptop', 'best tv for 1 room and 2 kids', "best kids' tv shows", 'best a/b switch for tv', 'best concat tool for video files', 'best laptop (2026) -- under $1000', 'best 65" -- oled or mini led tv']) {
    eq(`CP-803 SQL rules allow: "${q}"`, screenQuery(q).blocked, false);
  }

  // ── 12. CP-804: QA gaps from batch 9 ─────────────────────────────────────────
  // The test-kit exception applies only after "buy" and "where to buy".
  const cp804Blocked = [
    'how to cook heroin test kit',
    'how to get cocaine test kit',
    'order heroin testing kits',
    'how to make meth test strips',
    'where to get fentanyl test strips',
    // Spaced-out harm phrases, and their plain spelling.
    'make a b o m b',
    'b o m b making',
    'k i l l myself',
    'make a bomb',
    'bomb making',
    'how to kill myself',
    'making a bomb',
    'build a bomb',
    'bombmaking guide',
    'kill my self',
    'killing myself',
  ];
  for (const q of cp804Blocked) {
    eq(`CP-804 block: "${q}"`, screenQuery(q).blocked, true);
  }
  const cp804Allowed = [
    'fentanyl test strips',
    'buy fentanyl test strips',
    'where to buy fentanyl test strips',
    'buy mdma test kit',
    'bath bomb making kit',
    'best bath bomb maker',
    'how to make bath bombs',
    'make a bath bomb',
    'best bug spray to kill mosquitoes',
    'bomb shelter supplies',
    'building a bomb shelter',
    'nikon z 5', 'sony a 7 iv', 'canon r 6', 'a v receiver', 'i 9 laptop', 'buy a tv',
  ];
  for (const q of cp804Allowed) {
    eq(`CP-804 allow: "${q}"`, screenQuery(q).blocked, false);
  }

  // ── 13. CP-807: the verb spaced out, the article after it ("m a k e a bomb") ──
  const cp807Blocked = [
    'm a k e a bomb',
    'how to m a k e a bomb',
    'm a k e a b o m b',
    'b u i l d a bomb',
    'm a k i n g a bomb',
    'm 4 k 3 a bomb',
  ];
  for (const q of cp807Blocked) {
    eq(`CP-807 block: "${q}"`, screenQuery(q).blocked, true);
  }
  const cp807Allowed = [
    'm a k e a bath bomb',
    'b u i l d a bomb shelter',
    'a v receiver with a 4k pass through',
    'sony a 7 iv vs canon r 6',
  ];
  for (const q of cp807Allowed) {
    eq(`CP-807 allow: "${q}"`, screenQuery(q).blocked, false);
  }

  // ── 14. CP-808: "make an explosive", plain and spaced (QA note on PR #19) ──
  const cp808Blocked = [
    'make an explosive',
    'how to make an explosive',
    'make explosives at home',
    'making an explosive',
    'build an explosive device',
    'm a k e an explosive',
    'm a k e a n explosive',
    'm a k e a n e x p l o s i v e',
    'make an e x p l o s i v e',
    'm4ke an expl0sive',
  ];
  for (const q of cp808Blocked) {
    eq(`CP-808 block: "${q}"`, screenQuery(q).blocked, true);
  }
  const cp808Allowed = [
    'exploding kittens card game',
    'best explosive proof storage cabinet',
    'make an espresso at home',
    'best bath bomb maker',
    'best blender to make smoothies',
  ];
  for (const q of cp808Allowed) {
    eq(`CP-808 allow: "${q}"`, screenQuery(q).blocked, false);
  }

  return report;
}
