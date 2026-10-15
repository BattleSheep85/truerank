// Behavior pins for worker/engine/searxng.js: the SearXNG client that cleans
// metasearch answers (URL normalization, dedupe, junk and off-topic removal,
// rerank) and returns null for weak answers so the paid providers run next.
// The module is loaded with a dynamic import so a missing or broken module
// fails this suite alone instead of aborting the whole runner.

const MODULE_PATH = '../../worker/engine/searxng.js';
const NOW_MS = Date.UTC(2026, 9, 14);
const BASE_URL = 'https://searx.example.test';
const GATE_TOKEN = 'cd'.repeat(32);
const VACUUM_QUERY = 'best robot vacuum reddit';
const HEADPHONE_QUERY = 'Sony WH-1000XM5 review';

// Swap globalThis.fetch for a recording fake for the duration of fn().
async function withFakeFetch(respond, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

// Capture console output for the duration of fn() so token leaks are visible.
async function withCapturedLogs(fn) {
  const lines = [];
  const real = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { lines.push(args.map(String).join(' ')); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    await fn();
  } finally {
    Object.assign(console, real);
  }
  return lines.join('\n');
}

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });
const sortedCopy = (list) => [...list].sort();
const gateHeader = (call) => new Headers(call?.init?.headers).get('x-edge-gate');
const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
};

const vacuumResult = (url, extra = {}) => ({
  url,
  title: 'Best robot vacuum for pet hair',
  content: 'We tested every robot vacuum on carpet and hard floors.',
  engines: ['google'],
  ...extra,
});

const USABLE_FOUR = [
  vacuumResult('https://www.rtings.com/vacuum/reviews/best/robot'),
  vacuumResult('https://old.reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum/'),
  vacuumResult('https://www.wirecutter.example/robot-vacuums'),
  vacuumResult('https://vacuumwars.example/best-robot-vacuum'),
];

const JUNK = [
  { url: 'https://www.merriam-webster.com/dictionary/best', title: 'Best Definition & Meaning', content: 'best robot vacuum', engines: ['google'] },
  { url: 'https://www.pinterest.com/pin/123', title: 'Robot vacuum pins', content: 'robot vacuum', engines: ['bing'] },
  { url: 'ftp://files.example/robot-vacuum', title: 'Robot vacuum', content: 'robot vacuum', engines: ['bing'] },
];

function testConstants(m, t) {
  t.eq('SEARXNG_TIMEOUT_MS is 11000', m.SEARXNG_TIMEOUT_MS, 11000);
  t.eq('SEARXNG_MAX_RESULTS is 15', m.SEARXNG_MAX_RESULTS, 15);
  t.eq('SEARXNG_MIN_USABLE is 3', m.SEARXNG_MIN_USABLE, 3);
  t.ok('BLOCKED_DOMAINS is a Set', m.BLOCKED_DOMAINS instanceof Set);
  const required = [
    'pinterest.com', 'alibaba.com', 'aliexpress.com', 'taobao.com', 'tiktok.com',
    'merriam-webster.com', 'thefreedictionary.com', 'wiktionary.org',
    'dictionary.cambridge.org', 'csdn.net', 'zhihu.com', 'quora.com', 'redditmedia.com',
  ];
  for (const domain of required) t.ok(`BLOCKED_DOMAINS has ${domain}`, m.BLOCKED_DOMAINS?.has(domain));
}

function testNormalizeResultUrl(m, t) {
  const n = m.normalizeResultUrl;
  t.eq('normalize: old.reddit + utm + fragment + trailing slash',
    n('http://old.reddit.com/r/x/comments/abc/t/?utm_source=a#c'), 'https://reddit.com/r/x/comments/abc/t');
  t.eq('normalize: www.reddit to reddit', n('https://www.reddit.com/r/x/comments/abc/t'), 'https://reddit.com/r/x/comments/abc/t');
  t.eq('normalize: new.reddit to reddit', n('https://new.reddit.com/r/x/comments/abc/t'), 'https://reddit.com/r/x/comments/abc/t');
  t.eq('normalize: m.reddit to reddit', n('https://m.reddit.com/r/x/comments/abc/t'), 'https://reddit.com/r/x/comments/abc/t');
  t.eq('normalize: np.reddit to reddit', n('https://np.reddit.com/r/x/comments/abc/t'), 'https://reddit.com/r/x/comments/abc/t');
  t.eq('normalize: http forced to https, host lowercased, www stripped',
    n('http://WWW.RTINGS.com/nas/'), 'https://rtings.com/nas');
  t.eq('normalize: HN item id kept', n('https://news.ycombinator.com/item?id=1'), 'https://news.ycombinator.com/item?id=1');
  t.eq('normalize: root slash kept', n('https://www.example.com/'), 'https://example.com/');
  t.eq('normalize: tracking params dropped, other params kept',
    n('https://example.com/p?id=5&fbclid=a&gclid=b&ref=c&ref_src=d&srsltid=e&mc_cid=f&mc_eid=g&utm_medium=h'),
    'https://example.com/p?id=5');
  t.eq('normalize: ftp is null', n('ftp://files.example/a'), null);
  t.eq('normalize: javascript scheme is null', n('javascript:alert(1)'), null);
  t.eq('normalize: unparsable is null', n('not a url'), null);
}

function testQueryTokens(m, t) {
  const vac = m.queryTokens(VACUUM_QUERY);
  t.eq('queryTokens: robot vacuum terms', sortedCopy(vac.terms), ['robot', 'vacuum']);
  t.eq('queryTokens: robot vacuum has no model tokens', vac.modelTokens, []);
  const hp = m.queryTokens(HEADPHONE_QUERY);
  t.ok('queryTokens: sony is a term', hp.terms.includes('sony'));
  t.ok('queryTokens: review is a stopword', !hp.terms.includes('review'));
  t.eq('queryTokens: WH-1000XM5 model token', hp.modelTokens, ['wh1000xm5']);
  const nas = m.queryTokens('best nas site:reddit.com');
  t.eq('queryTokens: site operator dropped', nas.terms, ['nas']);
  t.eq('queryTokens: nas has no model tokens', nas.modelTokens, []);
  t.eq('queryTokens: quotes dropped', sortedCopy(m.queryTokens('"robot vacuum" best').terms), ['robot', 'vacuum']);
  t.eq('queryTokens: S8 model token', m.queryTokens('Roborock S8 review').modelTokens, ['s8']);
  t.eq('queryTokens: only stopwords gives no terms', m.queryTokens('best review reddit top vs').terms, []);
}

function testIsRelevant(m, t) {
  const vac = m.queryTokens(VACUUM_QUERY);
  const hp = m.queryTokens(HEADPHONE_QUERY);
  const dict = { url: 'https://example-dict.com/best', title: 'Best - definition', content: 'Best means of the highest quality.' };
  t.eq('isRelevant: dictionary page is off-topic', m.isRelevant(dict, vac), false);
  t.eq('isRelevant: robot vacuum page is relevant', m.isRelevant(vacuumResult('https://x.example/a'), vac), true);
  t.eq('isRelevant: empty tokens accept anything', m.isRelevant(dict, m.queryTokens('best review reddit')), true);
  t.eq('isRelevant: plural term matches singular text',
    m.isRelevant({ url: 'https://x.example/a', title: 'Vacuum guide', content: '' }, m.queryTokens('best vacuums')), true);
  t.eq('isRelevant: term found in url only',
    m.isRelevant({ url: 'https://x.example/robot-guide', title: 'Guide', content: '' }, m.queryTokens('robot')), true);
  const xm4 = { url: 'https://x.example/sony-xm4', title: 'Sony WH-1000XM4 review', content: 'The XM4 is great.' };
  t.eq('isRelevant: XM4 page is off-topic for XM5', m.isRelevant(xm4, hp), false);
  const xm5 = { url: 'https://x.example/sony-wh1000xm5', title: 'Sony headphones', content: 'Long test.' };
  t.eq('isRelevant: XM5 in url without hyphen matches', m.isRelevant(xm5, hp), true);
}

function testRankFiltering(m, t) {
  const raw = [
    ...JUNK,
    { url: 'https://example-dict.com/best', title: 'Best - definition', content: 'Best means of the highest quality.', engines: ['google'] },
    vacuumResult('https://en.m.wiktionary.org/wiki/robot_vacuum'),
    vacuumResult('https://notpinterest.com/robot-vacuum'),
    vacuumResult('https://www.rtings.com/vacuum/reviews/best/robot'),
  ];
  const urls = m.rankResults(raw, VACUUM_QUERY, NOW_MS).map((r) => r.url);
  t.ok('rank: blocked merriam-webster dropped', !urls.some((u) => u.includes('merriam-webster.com')));
  t.ok('rank: blocked pinterest dropped', !urls.some((u) => u.includes('www.pinterest.com') || u === 'https://pinterest.com/pin/123'));
  t.ok('rank: blocked subdomain of wiktionary dropped', !urls.some((u) => u.includes('wiktionary.org')));
  t.ok('rank: unblocked dictionary-like page dropped as off-topic', !urls.some((u) => u.includes('example-dict.com')));
  t.ok('rank: non-http url dropped', !urls.some((u) => u.startsWith('ftp:')));
  t.ok('rank: lookalike host notpinterest.com kept', urls.includes('https://notpinterest.com/robot-vacuum'));
  t.ok('rank: relevant expert page kept', urls.includes('https://rtings.com/vacuum/reviews/best/robot'));
  const hp = m.rankResults([
    { url: 'https://x.example/sony-xm4', title: 'Sony WH-1000XM4 review', content: 'XM4', engines: ['google'] },
    { url: 'https://y.example/sony-xm5', title: 'Sony WH-1000XM5 review', content: 'XM5', engines: ['google'] },
  ], HEADPHONE_QUERY, NOW_MS).map((r) => r.url);
  t.eq('rank: XM4-only result dropped for XM5 query', hp, ['https://y.example/sony-xm5']);
}

function testRankDedupe(m, t) {
  const longer = 'We tested every robot vacuum on carpet, tile, and pet hair for six weeks.';
  const merged = m.rankResults([
    vacuumResult('https://old.reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum/', { engines: ['google'], content: 'robot vacuum' }),
    vacuumResult('https://www.reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum?utm_source=x', { engines: ['bing', 'google'], content: longer }),
  ], VACUUM_QUERY, NOW_MS);
  t.eq('dedupe: old and www reddit merge to one', merged.length, 1);
  t.eq('dedupe: merged url is normalized', merged[0]?.url, 'https://reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum');
  t.eq('dedupe: engines unioned', sortedCopy(merged[0]?.engines ?? []), ['bing', 'google']);
  t.eq('dedupe: longest content kept', merged[0]?.content, longer);
}

// Score of one result ranked alone, so every compared pair shares input position 0.
const soloScore = (m, raw, query = VACUUM_QUERY) => m.rankResults([raw], query, NOW_MS)[0]?.score;
const ranksAbove = (a, b) => typeof a === 'number' && typeof b === 'number' && a > b;

function testRankOrdering(m, t) {
  const unknown = soloScore(m, vacuumResult('https://randomblog-xyz.net/best-robot-vacuum'));
  const expert = soloScore(m, vacuumResult('https://www.rtings.com/vacuum/reviews/best/robot'));
  const community = soloScore(m, vacuumResult('https://www.reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum'));
  t.ok('order: expert domain above unknown domain', ranksAbove(expert, unknown));
  t.ok('order: community domain above unknown domain', ranksAbove(community, unknown));
  const three = soloScore(m, vacuumResult('https://randomblog-xyz.net/best-robot-vacuum', { engines: ['google', 'bing', 'mojeek'] }));
  t.ok('order: 3 engines above 1 engine', ranksAbove(three, unknown));
  const blog = (extra) => vacuumResult('https://randomblog-xyz.net/best-robot-vacuum', extra);
  t.ok('order: recent publishedDate above old publishedDate',
    ranksAbove(soloScore(m, blog({ publishedDate: '2026-03-01T00:00:00Z' })), soloScore(m, blog({ publishedDate: '2023-01-01T00:00:00Z' }))));
  t.ok('order: current year in title above old year in title',
    ranksAbove(soloScore(m, blog({ title: 'Best robot vacuum 2026' })), soloScore(m, blog({ title: 'Best robot vacuum 2019' }))));
  t.ok('order: previous year in url above old year in url', ranksAbove(
    soloScore(m, vacuumResult('https://randomblog-xyz.net/2025/best-robot-vacuum')),
    soloScore(m, vacuumResult('https://randomblog-xyz.net/2019/best-robot-vacuum'))));
  const pair = m.rankResults([
    vacuumResult('https://randomblog-xyz.net/best-robot-vacuum'),
    vacuumResult('https://www.rtings.com/vacuum/reviews/best/robot', { engines: ['google', 'bing', 'mojeek'] }),
  ], VACUUM_QUERY, NOW_MS);
  t.eq('order: output sorted by score desc', pair.map((r) => r.url)[0], 'https://rtings.com/vacuum/reviews/best/robot');
}

function testRankShapeAndCap(m, t) {
  const dated = m.rankResults([vacuumResult('https://x.example/a', { publishedDate: '2026-03-01T00:00:00Z' })], VACUUM_QUERY, NOW_MS)[0];
  t.eq('shape: publishedAt is epoch seconds', dated?.publishedAt, Date.UTC(2026, 2, 1) / 1000);
  t.eq('shape: output keys', Object.keys(dated ?? {}).sort(), ['content', 'engines', 'publishedAt', 'score', 'title', 'url']);
  const undated = m.rankResults([vacuumResult('https://x.example/a')], VACUUM_QUERY, NOW_MS)[0];
  t.ok('shape: publishedAt undefined without a date', undated !== undefined && undated.publishedAt === undefined);
  t.ok('shape: score is a number', typeof undated?.score === 'number');
  const thirty = Array.from({ length: 30 }, (_, i) => vacuumResult(`https://site${i}.example/robot-vacuum`));
  const capped = m.rankResults(thirty, VACUUM_QUERY, NOW_MS);
  t.eq('cap: 30 inputs capped at SEARXNG_MAX_RESULTS', capped.length, m.SEARXNG_MAX_RESULTS);
  t.ok('cap: scores non-increasing', capped.every((r, i) => i === 0 || capped[i - 1].score >= r.score));
}

function testRankImmutability(m, t) {
  const raw = [...USABLE_FOUR, ...JUNK, USABLE_FOUR[1]];
  const before = JSON.stringify(raw);
  m.rankResults(raw, VACUUM_QUERY, NOW_MS);
  t.eq('immutability: input deep-equal after rankResults', JSON.stringify(raw), before);
  const frozen = deepFreeze(structuredClone(raw));
  let threw = false;
  try { m.rankResults(frozen, VACUUM_QUERY, NOW_MS); } catch { threw = true; }
  t.eq('immutability: deep-frozen input does not throw', threw, false);
}

async function testSearchRequest(m, t) {
  await withFakeFetch(() => jsonResponse({ results: USABLE_FOUR }), async (calls) => {
    await m.searxngSearch(VACUUM_QUERY, `${BASE_URL}//`, { timeRange: 'y', gateToken: `  ${GATE_TOKEN}\n` });
    const url = new URL(calls[0]?.url ?? 'https://invalid.test/');
    t.eq('request: trailing slashes stripped, /search path', `${url.origin}${url.pathname}`, `${BASE_URL}/search`);
    t.eq('request: q param', url.searchParams.get('q'), VACUUM_QUERY);
    t.eq('request: format=json', url.searchParams.get('format'), 'json');
    t.eq('request: no time_range even for timeRange y', url.searchParams.has('time_range'), false);
    t.ok('request: no categories=news by default', url.searchParams.get('categories') !== 'news');
    t.eq('request: gate header trimmed', gateHeader(calls[0]), GATE_TOKEN);
  });
  await withFakeFetch(() => jsonResponse({ results: USABLE_FOUR }), async (calls) => {
    await m.searxngSearch(VACUUM_QUERY, BASE_URL, { topic: 'news' });
    t.eq('request: categories=news for topic news', new URL(calls[0]?.url ?? 'https://invalid.test/').searchParams.get('categories'), 'news');
    t.eq('request: no gate header without token', gateHeader(calls[0]), null);
  });
  await withFakeFetch(() => jsonResponse({ results: USABLE_FOUR }), async (calls) => {
    await m.searxngSearch(VACUUM_QUERY, BASE_URL, { gateToken: '   ' });
    t.eq('request: no gate header for blank token', gateHeader(calls[0]), null);
  });
}

async function nullCase(m, t, name, respond, baseUrl = BASE_URL) {
  let result;
  await withFakeFetch(respond, async () => {
    result = await m.searxngSearch(VACUUM_QUERY, baseUrl, { gateToken: GATE_TOKEN });
  });
  t.eq(name, result, null);
}

async function testSearchNulls(m, t) {
  let called = false;
  await nullCase(m, t, 'null: empty baseUrl', () => { called = true; return jsonResponse({ results: USABLE_FOUR }); }, '');
  t.eq('null: empty baseUrl makes no request', called, false);
  await nullCase(m, t, 'null: HTTP 500', () => new Response('boom', { status: 500 }));
  await nullCase(m, t, 'null: fetch throws', () => { throw new TypeError('network down'); });
  await nullCase(m, t, 'null: abort', () => { throw new DOMException('aborted', 'AbortError'); });
  await nullCase(m, t, 'null: invalid JSON', () => new Response('not json', { status: 200 }));
  await nullCase(m, t, 'null: only 2 usable results', () => jsonResponse({ results: [...USABLE_FOUR.slice(0, 2), ...JUNK] }));
}

async function testSearchSuccess(m, t) {
  let labeled, plain;
  const printed = await withCapturedLogs(async () => {
    await withFakeFetch(() => jsonResponse({ results: [...USABLE_FOUR, ...JUNK] }), async () => {
      labeled = await m.searxngSearch(VACUUM_QUERY, BASE_URL, { sourceLabel: 'searxng', gateToken: GATE_TOKEN });
      plain = await m.searxngSearch(VACUUM_QUERY, BASE_URL, { gateToken: GATE_TOKEN });
    });
    await withFakeFetch(() => new Response('forbidden', { status: 403 }), async () => {
      await m.searxngSearch(VACUUM_QUERY, BASE_URL, { gateToken: GATE_TOKEN });
    });
  });
  t.eq('success: 4 usable results returned', labeled?.length, 4);
  t.ok('success: sourceLabel applied', labeled?.every((r) => r.source === 'searxng'));
  t.ok('success: default source is web', plain?.every((r) => r.source === 'web'));
  t.eq('success: result keys', Object.keys(labeled?.[0] ?? {}).sort(), ['content', 'publishedAt', 'source', 'title', 'url']);
  t.ok('success: urls normalized', labeled?.some((r) => r.url === 'https://reddit.com/r/RobotVacuums/comments/a1/best_robot_vacuum'));
  t.ok('success: junk removed', !labeled?.some((r) => /merriam-webster|pinterest|^ftp:/.test(r.url)));
  t.ok('logs: gate token never printed', !printed.includes(GATE_TOKEN));
}

// Review fix round regressions (findings 1 to 6).
function testRelevanceRegressions(m, t) {
  t.eq('regression: model-only query keeps matching result',
    m.isRelevant({ url: 'https://x.example/a', title: 'Roborock S8 review', content: '' }, m.queryTokens('S8 review')), true);
  t.eq('regression: 4k is not a model token', m.queryTokens('best 4k tv').modelTokens, []);
  for (const unit of ['2nd', '6ft', '65in', '1tb', '120hz']) {
    t.eq(`regression: ${unit} is not a model token`, m.queryTokens(`best ${unit} tv`).modelTokens, []);
  }
  t.ok('regression: pure number is not a term', !m.queryTokens('best tv 2026').terms.includes('2026'));
  t.eq('regression: 4k query keeps a 4K TV result',
    m.isRelevant({ url: 'https://x.example/tv', title: 'Best 4K TVs of the year', content: '' }, m.queryTokens('best 4k tv')), true);
  const blog = (publishedDate) => vacuumResult('https://randomblog-xyz.net/best-robot-vacuum', { publishedDate });
  t.ok('regression: future publishedDate gets no fresh bonus',
    ranksAbove(soloScore(m, blog('2026-03-01T00:00:00Z')), soloScore(m, blog('9999-01-01T00:00:00Z'))));
}

function testUrlRegressions(m, t) {
  t.eq('regression: www. host with empty rest is null', m.normalizeResultUrl('https://www./evil.example/x'), null);
  t.eq('regression: trailing dot stripped from host', m.normalizeResultUrl('https://Example.com./a'), 'https://example.com/a');
  t.eq('regression: url over 2048 chars is null', m.normalizeResultUrl(`https://example.com/${'a'.repeat(3000)}`), null);
  const started = Date.now();
  m.normalizeResultUrl(`https://example.com/a${'/'.repeat(5000)}b`);
  t.ok('regression: 5000 inner slashes return within 50 ms', Date.now() - started < 50);
  t.eq('regression: userinfo host spoof dropped', m.normalizeResultUrl('https://rtings.com@evil.example/x'), 'https://evil.example/x');
  t.eq('regression: credentials dropped', m.normalizeResultUrl('https://user:pass@example.com/x'), 'https://example.com/x');
  const slashUrl = `https://example.com/a${'/'.repeat(2000)}b`;
  const slashStart = Date.now();
  const slashOut = m.normalizeResultUrl(slashUrl);
  t.ok('regression: 2000 inner slashes under the length cap return a string within 50 ms',
    typeof slashOut === 'string' && Date.now() - slashStart < 50);
  t.eq('regression: 6qt is not a model token', m.queryTokens('best 6qt air fryer').modelTokens, []);
}

async function testGateControlChars(m, t) {
  const badToken = 'ab\ncd';
  let calls = [];
  const printed = await withCapturedLogs(async () => {
    await withFakeFetch(() => jsonResponse({ results: USABLE_FOUR }), async (c) => {
      await m.searxngSearch(VACUUM_QUERY, BASE_URL, { gateToken: badToken });
      calls = c;
    });
  });
  t.eq('regression: control-char token sends no gate header', gateHeader(calls[0]), null);
  t.ok('regression: control-char token not logged', !printed.includes(badToken) && !printed.includes('cd'));
  t.ok('regression: invalid gate token logged by message', printed.includes('[searxng] gate token has invalid characters, header omitted'));
}

const SYNC_GROUPS = [
  testConstants, testNormalizeResultUrl, testQueryTokens, testIsRelevant,
  testRankFiltering, testRankDedupe, testRankOrdering, testRankShapeAndCap, testRankImmutability,
  // Every group is awaited, so the async regression group can sit here.
  testRelevanceRegressions, testUrlRegressions, testGateControlChars,
];
const ASYNC_GROUPS = [testSearchRequest, testSearchNulls, testSearchSuccess];

export async function runSearxngTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);
  const t = { eq, ok };

  let m;
  try {
    m = await import(MODULE_PATH);
  } catch (err) {
    report.failed++;
    report.failures.push(`cannot import worker/engine/searxng.js: ${err instanceof Error ? err.message : String(err)}`);
    return report;
  }
  for (const group of [...SYNC_GROUPS, ...ASYNC_GROUPS]) {
    try {
      await group(m, t);
    } catch (err) {
      report.failed++;
      report.failures.push(`${group.name} threw: ${err instanceof Error ? err.stack : String(err)}`);
    }
  }
  return report;
}
