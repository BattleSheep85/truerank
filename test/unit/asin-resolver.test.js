// Full-coverage assertions for asin-resolver.js's retailer-fallback URL gate
// (worker/lib/asin-resolver.js). Fixtures are REAL URLs captured 2026-07-01
// from live Serper site: searches, not synthetic guesses — this is what
// motivated the strict accept() pattern in the first place: the same
// site:{retailer} technique that works cleanly for Amazon returns genuine
// product pages about as often as Q&A/review-tab/search-listing noise for
// other retailers.
import { RETAILER_FALLBACKS, titleMatches, resolveAsins } from '../../worker/lib/asin-resolver.js';

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

const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });
const PRODUCT = { name: 'Synology DS224', brand: 'Synology', productUrl: '' };

export async function runAsinResolverTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  const bestbuy = RETAILER_FALLBACKS.find((r) => r.host === 'bestbuy.com');
  const newegg = RETAILER_FALLBACKS.find((r) => r.host === 'newegg.com');
  ok('bestbuy.com fallback registered', !!bestbuy);
  ok('newegg.com fallback registered', !!newegg);

  // ── Best Buy: accept real product pages, reject Q&A (real URLs, 2026-07-01) ──
  ok('bestbuy: accepts a real product page (older /site/{slug}/{sku}.p scheme)',
    bestbuy.accept('https://www.bestbuy.com/site/msi-mag-274qpf-x30mv-27-class-wqhd-gaming-mini-led-monitor/6555061.p'));
  ok('bestbuy: accepts a product page with query string',
    bestbuy.accept('https://www.bestbuy.com/site/synology-ds224-2-bay-nas/6570551.p?skuId=6570551'));
  ok('bestbuy: accepts a real product page (newer /product/.../sku/{id} scheme, real URL hit live)',
    bestbuy.accept('https://www.bestbuy.com/product/anker-powercore-20000-mah-portable-charger-for-most-usb-enabled-devices-black/J36FHS8PKG/sku/5948567'));
  eq('bestbuy: rejects a Q&A page (real noise hit live)', bestbuy.accept(
    'https://www.bestbuy.com/site/questions/wd-red-plus-10tb-nas-internal-hard-drive/6523111/question/c130c87d-3dc8-3ef9-b579-438cd19b2a29',
  ), false);
  eq('bestbuy: rejects a Q&A index page (real noise hit live)', bestbuy.accept(
    'https://www.bestbuy.com/site/questions/wd-red-plus-10tb-nas-internal-hard-drive/6523111',
  ), false);
  eq('bestbuy: rejects a review-tab page (real noise hit live)', bestbuy.accept(
    'https://www.bestbuy.com/site/reviews/anker-powercore-20000-mah-portable-charger-for-most-usb-enabled-devices-black/5948567?page=2',
  ), false);
  eq('bestbuy: rejects a non-product page with no .p suffix',
    bestbuy.accept('https://www.bestbuy.com/site/searchpage.jsp?st=nas'), false);

  // ── Newegg: accept /p/{code}, reject /p/pl (its own search results, real noise hit live) ──
  ok('newegg: accepts a real product page', newegg.accept('https://www.newegg.com/p/N82E16834234123'));
  ok('newegg: accepts a product page with query string', newegg.accept('https://www.newegg.com/msi/p/N82E16834234123?Item=X'));
  eq('newegg: rejects its own search-results page (real noise hit live)',
    newegg.accept('https://www.newegg.com/p/pl?d=nas+synology+ds224++hdd&srsltid=abc'), false);
  eq('newegg: rejects /p/pl even with a trailing slash', newegg.accept('https://www.newegg.com/p/pl/'), false);

  // ── titleMatches: shared with the Amazon path, exercised here for the retailer path too ──
  ok('titleMatches: 2+ shared tokens', titleMatches('Synology DS224', 'Synology DiskStation DS224 2-Bay NAS'));
  eq('titleMatches: unrelated title rejected', titleMatches('Synology DS224', 'Apple MacBook Pro 16-inch'), false);
  ok('titleMatches: single-token subject matches on 1 shared token', titleMatches('Bose', 'Bose QuietComfort Earbuds'));

  // ── Provider selection: Brave when Serper has no key, Serper otherwise ──
  await withFakeFetch(() => jsonResponse({
    web: { results: [{ url: 'https://www.amazon.com/Synology-DS224/dp/B0ABCDEFGH/ref=x', title: 'Synology DS224+ NAS' }] },
  }), async (calls) => {
    const out = await resolveAsins({ BRAVE_API_KEY: 'brave-key', AMAZON_AFFILIATE_TAG: 'tag-20' }, [PRODUCT]);
    eq('brave only: one request', calls.length, 1);
    const u = new URL(calls[0].url);
    eq('brave only: hits the Brave web endpoint', `${u.host}${u.pathname}`, 'api.search.brave.com/res/v1/web/search');
    eq('brave only: same site: query shape as Serper', u.searchParams.get('q'), 'site:amazon.com "Synology DS224"');
    eq('brave only: sends the subscription token', calls[0].init.headers['X-Subscription-Token'], 'brave-key');
    eq('brave only: ASIN set from /dp/ result', out[0].productUrl, 'https://www.amazon.com/dp/B0ABCDEFGH');
    ok('brave only: affiliate tag applied', String(out[0].affiliateUrl).includes('tag=tag-20'));
    eq('brave only: input product not mutated', PRODUCT.productUrl, '');
  });

  await withFakeFetch(() => jsonResponse({
    web: { results: [{ url: 'https://www.amazon.co.uk/gp/product/B0UKASIN01', title: 'Synology DS224 2-Bay' }] },
  }), async () => {
    const out = await resolveAsins({ BRAVE_API_KEY: 'brave-key' }, [PRODUCT]);
    eq('brave only: /gp/product/ form resolves', out[0].productUrl, 'https://www.amazon.com/dp/B0UKASIN01');
  });

  await withFakeFetch(() => jsonResponse({ web: { results: [] } }), async (calls) => {
    const out = await resolveAsins({ BRAVE_API_KEY: 'brave-key' }, [PRODUCT]);
    eq('brave only: no Amazon hit skips the Serper-only retailer fallback', calls.length, 1);
    eq('brave only: no hit leaves product unchanged', out[0], PRODUCT);
  });

  await withFakeFetch(() => jsonResponse({
    organic: [{ link: 'https://www.amazon.com/dp/B0SERPER01', title: 'Synology DS224+ NAS' }],
  }), async (calls) => {
    const out = await resolveAsins({ SERPER_API_KEY: 'serper-key', BRAVE_API_KEY: 'brave-key' }, [PRODUCT]);
    eq('both keys: Serper only', calls.map((c) => new URL(c.url).host), ['google.serper.dev']);
    eq('both keys: Serper body unchanged', JSON.parse(calls[0].init.body), { q: 'site:amazon.com "Synology DS224"', num: 3 });
    eq('both keys: ASIN from Serper', out[0].productUrl, 'https://www.amazon.com/dp/B0SERPER01');
  });

  await withFakeFetch(() => { throw new Error('fetch must not be called'); }, async (calls) => {
    const out = await resolveAsins({}, [PRODUCT]);
    eq('no keys: no request', calls.length, 0);
    eq('no keys: product untouched', out[0], PRODUCT);
  });

  return report;
}
