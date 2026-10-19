// CP-396: thin-corpus fallback. When a preview of the extraction finds fewer than 3 products
// (the "linen shirts" case: 250 sources, 0 products), run a few rewritten searches aimed at
// text-heavy pages and read the best unread results directly.
import { readableBodyCount, thinCorpusQueries, pickPagesToRead, runThinCorpusFallback, MIN_PRODUCTS } from '../../worker/engine/thin-corpus.js';

const body = 'Real review text about linen shirts and how they wear. '.repeat(12);
const snip = (url, score = 50, tags = []) => ({ url, title: 'Best linen shirts', content: 'Short search snippet.', credibility: { score, tags } });
const full = (url, score = 60, tags = ['community']) => ({ url, title: 'Linen shirts thread', content: body, credibility: { score, tags } });

export async function runThinCorpusTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // ── readableBodyCount ─────────────────────────────────────────────────────
  eq('snippets are not readable bodies', readableBodyCount([snip('https://a.example/1'), snip('https://a.example/2')]), 0);
  eq('a long credible body counts', readableBodyCount([full('https://a.example/1')]), 1);
  eq('a long low-credibility body does not count', readableBodyCount([full('https://a.example/1', 20, ['listicle'])]), 0);
  eq('a long body of only non-credible genres does not count', readableBodyCount([full('https://a.example/1', 60, ['manufacturer'])]), 0);
  eq('bad input counts 0', readableBodyCount(null), 0);
  eq('product threshold is 3', MIN_PRODUCTS, 3);

  // ── thinCorpusQueries ─────────────────────────────────────────────────────
  eq('queries use the topical category', thinCorpusQueries('best linen shirts for men under $80', 'linen shirts'),
    ['linen shirts recommendations reddit', 'linen shirts honest review', 'linen shirts long term review forum']);
  eq('queries fall back to the raw query', thinCorpusQueries('best linen shirts', '')[0], 'best linen shirts recommendations reddit');
  eq('empty input gives no queries', thinCorpusQueries('', ''), []);

  // ── pickPagesToRead ───────────────────────────────────────────────────────
  const pool = [
    snip('https://www.instagram.com/reel/x', 55),
    snip('https://www.youtube.com/watch?v=abc', 56),
    snip('https://shop.example/linen', 50, ['manufacturer']),
    snip('https://www.reddit.com/r/malefashionadvice/1', 55, ['community']),
    full('https://already.example/read'),
    snip('https://www.gq.com/best-linen', 50),
    snip('http://insecure.example/x', 70),
  ];
  const picked = pickPagesToRead(pool, 2).map((s) => s.url);
  eq('reads the most credible unread pages first', picked, ['https://www.reddit.com/r/malefashionadvice/1', 'https://www.gq.com/best-linen']);
  eq('never picks social video, manufacturer, http or already-read pages',
    pickPagesToRead(pool, 9).some((s) => /instagram|youtube|shop\.example|insecure|already/.test(s.url)), false);

  // ── runThinCorpusFallback ─────────────────────────────────────────────────
  const thin = [snip('https://www.gq.com/best-linen', 50), snip('https://nymag.com/strategist/linen', 50)];
  const searched = [];
  const search = async (q) => { searched.push(q); return [snip(`https://www.reddit.com/r/x/${searched.length}`, 55, ['community'])]; };
  const reads = [];
  const read = async (s) => { reads.push(s.url); return { ...s, content: body }; };
  const r = await runThinCorpusFallback({ query: 'best linen shirts', topicalCategory: 'linen shirts', sources: thin, maxSearches: 3, maxReads: 3, deps: { search, read, countProducts: () => 0 } });
  eq('runs when the corpus is thin', r.triggered, true);
  eq('runs the rewrite searches', r.searched, 3);
  eq('reads up to maxReads pages', r.read, 3);
  eq('returns every source once (old + new)', r.sources.length, 5);
  eq('read pages now hold their body', readableBodyCount(r.sources), 3);
  eq('does not mutate the input sources', thin[0].content, 'Short search snippet.');

  const rich = [full('https://a.example/1'), full('https://a.example/2'), full('https://a.example/3')];
  const r2 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: rich, maxSearches: 3, maxReads: 3, deps: { search, read, countProducts: () => 3 } });
  eq('skips when the preview already finds 3 products', [r2.triggered, r2.searched, r2.read], [false, 0, 0]);
  eq('skip returns the sources unchanged', r2.sources, rich);

  const boom = async () => { throw new Error('provider down'); };
  const r3 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: thin, maxSearches: 2, maxReads: 2, deps: { search: boom, read: boom, countProducts: () => 0 } });
  eq('provider failures never throw', r3.triggered, true);
  eq('failed reads keep the snippet', r3.sources.length, 2);

  const dupSearch = async () => [snip('https://www.gq.com/best-linen/', 50)];
  const r4 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: thin, maxSearches: 1, maxReads: 0, deps: { search: dupSearch, read, countProducts: () => 0 } });
  eq('a known page from search is not added twice', r4.sources.length, 2);

  const r5 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: thin, maxSearches: 0, maxReads: 0, deps: { search, read, countProducts: () => 0 } });
  eq('no budget → nothing runs', [r5.searched, r5.read], [0, 0]);

  // A clearly rich corpus skips the extraction preview entirely.
  let previewed = 0;
  const manyBodies = Array.from({ length: 12 }, (_, i) => full(`https://rich.example/${i}`));
  const r7 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'x', sources: manyBodies, deps: { search, read, countProducts: () => { previewed++; return 0; } } });
  eq('12+ readable bodies skip the preview', [r7.triggered, previewed], [false, 0]);

  // Searches run in parallel, and the whole step stops at its deadline.
  let inFlight = 0, peak = 0;
  const slowSearch = async (q) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((res) => setTimeout(res, 20)); inFlight--; return [snip(`https://www.reddit.com/r/p/${q.length}`, 55)]; };
  await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: thin, maxSearches: 3, maxReads: 0, deps: { search: slowSearch, read, countProducts: () => 0 } });
  eq('the rewrite searches run in parallel', peak, 3);
  const never = () => new Promise(() => {});
  const t0 = Date.now();
  const r8 = await runThinCorpusFallback({ query: 'q', topicalCategory: 'linen shirts', sources: thin, maxSearches: 2, maxReads: 2, deadlineMs: 50, deps: { search: never, read: never, countProducts: () => 0 } });
  eq('a hung provider cannot hold the step past its deadline', Date.now() - t0 < 1000, true);
  eq('after a timeout the sources are unchanged', r8.sources.length, 2);

  // Default preview runs the real extractor: snippets-only sources give 0 products → triggers.
  const r6 = await runThinCorpusFallback({ query: 'best linen shirts', topicalCategory: 'linen shirts', sources: thin, maxSearches: 0, maxReads: 0, deps: { search, read } });
  eq('the default extraction preview triggers on a snippet-only corpus', r6.triggered, true);

  return report;
}
