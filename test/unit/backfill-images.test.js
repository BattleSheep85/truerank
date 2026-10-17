// Unit tests for scripts/backfill-images.mjs (CP-715): the backfill uses the
// image resolver's provider chain (SearXNG images, Brave backup) instead of
// calling Serper only, and keeps its verify-then-write candidate order.
import { backfillEnv, pickVerifiedImage, parseLimit, isSearchOutage } from '../../scripts/backfill-images.mjs';
import { imageCandidateSearch, rankImages, pickBestImage } from '../../worker/lib/image-resolver.js';

const SEARX_URL = 'https://searx.example.test';
const AMAZON_IMG = 'https://m.media-amazon.com/images/ds224.jpg';
const BLOG_IMG = 'https://blog.example/ds224.jpg';

// Swap globalThis.fetch (and console.log) for the duration of fn().
async function withFakeFetch(respond, fn) {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(String(url), init);
  };
  console.log = () => {};
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

export async function runBackfillImagesTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a);
    const E = JSON.stringify(e);
    if (A === E) report.passed++;
    else {
      report.failed++;
      report.failures.push(`${name}: expected ${E}, got ${A}`);
    }
  };
  const ok = (name, cond) => eq(name, Boolean(cond), true);

  // backfillEnv: .dev.vars first, the process environment second.
  const env = backfillEnv({ SEARXNG_URL: SEARX_URL }, { LITELLM_GATE_TOKEN: 'gate', BRAVE_API_KEY: 'brave', OTHER: 'x' });
  eq('backfillEnv: picks the search keys from both sources', env, {
    SERPER_API_KEY: undefined, SEARXNG_URL: SEARX_URL, LITELLM_GATE_TOKEN: 'gate', BRAVE_API_KEY: 'brave',
  });
  eq('backfillEnv: the file value wins', backfillEnv({ SEARXNG_URL: 'a' }, { SEARXNG_URL: 'b' }).SEARXNG_URL, 'a');
  ok('backfillEnv: frozen copy', Object.isFrozen(env));

  // imageCandidateSearch: same chain as resolveImages.
  eq('imageCandidateSearch: no provider key → null', imageCandidateSearch({}), null);
  await withFakeFetch(() => json({ results: [
    { img_src: BLOG_IMG, resolution: '800x800' },
    { img_src: AMAZON_IMG, resolution: '600x600' },
  ] }), async (calls) => {
    const search = imageCandidateSearch({ SEARXNG_URL: SEARX_URL, LITELLM_GATE_TOKEN: 'gate' });
    const images = await search('Synology DS224 product');
    eq('imageCandidateSearch: SearXNG only, one call', calls.length, 1);
    const u = new URL(calls[0].url);
    eq('imageCandidateSearch: SearXNG images category', [u.host, u.searchParams.get('categories')], ['searx.example.test', 'images']);
    eq('imageCandidateSearch: sends the edge gate', calls[0].init.headers['X-Edge-Gate'], 'gate');
    eq('imageCandidateSearch: Serper image shape', images.map((im) => im.imageUrl), [BLOG_IMG, AMAZON_IMG]);
  });
  await withFakeFetch((url) => (url.startsWith(SEARX_URL)
    ? new Response('down', { status: 502 })
    : json({ results: [{ properties: { url: AMAZON_IMG, width: 500, height: 500 } }] })), async (calls) => {
    const search = imageCandidateSearch({ SEARXNG_URL: SEARX_URL, BRAVE_API_KEY: 'brave' });
    const images = await search('Synology DS224 product');
    eq('imageCandidateSearch: SearXNG failure retries on Brave', new URL(calls.at(-1).url).host, 'api.search.brave.com');
    eq('imageCandidateSearch: Brave results in Serper shape', images.map((im) => im.imageUrl), [AMAZON_IMG]);
  });
  await withFakeFetch(() => new Response('down', { status: 502 }), async () => {
    const search = imageCandidateSearch({ SEARXNG_URL: SEARX_URL });
    eq('imageCandidateSearch: SearXNG failure, no Brave key → []', await search('q product'), []);
  });

  // rankImages: the resolver's ranking, best first.
  const pool = [
    { imageUrl: BLOG_IMG, imageWidth: 800, imageHeight: 800 },
    { imageUrl: AMAZON_IMG, imageWidth: 500, imageHeight: 500 },
    { imageUrl: 'https://x/tiny.jpg', imageWidth: 50, imageHeight: 50 },
    { imageUrl: 'http://shop.example/p.jpg', imageWidth: 400, imageHeight: 400 },
  ];
  eq('rankImages: preferred host first, junk dropped, http upgraded', rankImages(pool), [AMAZON_IMG, BLOG_IMG, 'https://shop.example/p.jpg']);
  eq('rankImages: limit', rankImages(pool, 2), [AMAZON_IMG, BLOG_IMG]);
  eq('rankImages: not an array → []', rankImages(null), []);
  eq('pickBestImage: still the top ranked image', pickBestImage(pool), AMAZON_IMG);

  // pickVerifiedImage: first ranked candidate that really serves an image.
  const search = async () => pool;
  const checked = [];
  const verify = async (url) => { checked.push(url); return url === BLOG_IMG; };
  eq('pickVerifiedImage: skips a candidate that fails the check', await pickVerifiedImage(search, 'q', verify), {
    chosen: BLOG_IMG, ranked: [AMAZON_IMG, BLOG_IMG, 'https://shop.example/p.jpg'],
  });
  eq('pickVerifiedImage: stops at the first good one', checked, [AMAZON_IMG, BLOG_IMG]);
  eq('pickVerifiedImage: none verify → empty choice', await pickVerifiedImage(search, 'q', async () => false), {
    chosen: '', ranked: [AMAZON_IMG, BLOG_IMG, 'https://shop.example/p.jpg'],
  });
  eq('pickVerifiedImage: no results', await pickVerifiedImage(async () => [], 'q', verify), { chosen: '', ranked: [] });

  // parseLimit: a positive whole number, else the default; never NaN.
  eq('parseLimit: no flag → default', parseLimit(['node', 'x']), 10000);
  eq('parseLimit: --limit 20', parseLimit(['node', 'x', '--limit', '20']), 20);
  eq('parseLimit: bad value → null', parseLimit(['node', 'x', '--limit', 'abc']), null);
  eq('parseLimit: zero → null', parseLimit(['node', 'x', '--limit', '0']), null);

  // isSearchOutage: a long run of empty searches means the provider is down.
  eq('isSearchOutage: a few empty searches are normal', isSearchOutage(5), false);
  eq('isSearchOutage: 26 empty searches in a row → outage', isSearchOutage(26), true);

  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await runBackfillImagesTests();
  console.log(`backfill-images: ${r.passed}/${r.passed + r.failed} passed`);
  if (r.failed > 0) {
    for (const f of r.failures) console.error('  FAIL', f);
    process.exit(1);
  }
}
