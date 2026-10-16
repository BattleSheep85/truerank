// Coverage for the post-synthesis resolvers (Serper-backed, fetch mocked):
// asin-resolver (direct /dp link recovery) + image-resolver (product photos).
// Both must NEVER throw and pass unresolved products through unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAsins } from '../../worker/lib/asin-resolver.js';
import { resolveImages, buildImageQuery, pickBestImage, braveImagesToSerperShape } from '../../worker/lib/image-resolver.js';
import { parseResolution, searxngImageSearch } from '../../worker/engine/searxng.js';

const ENV = { SERPER_API_KEY: 'test-key', AMAZON_AFFILIATE_TAG: 'battlesheep0a-20' };
afterEach(() => vi.unstubAllGlobals());

describe('resolveAsins', () => {
  it('no key → products unchanged', async () => {
    const out = await resolveAsins({}, [{ name: 'X', productUrl: '' }]);
    expect(out[0].productUrl).toBe('');
  });

  it('skips products that already have a /dp link', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const out = await resolveAsins(ENV, [{ name: 'X', productUrl: 'https://www.amazon.com/dp/B0EXISTING1' }]);
    expect(spy).not.toHaveBeenCalled();
    expect(out[0].productUrl).toContain('/dp/B0EXISTING1');
  });

  it('recovers a /dp link via Serper when the title matches', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      organic: [{ link: 'https://www.amazon.com/dp/B0ABCDEFGH', title: 'Synology DS224+ NAS Enclosure' }],
    }), { status: 200 })));
    const out = await resolveAsins(ENV, [{ name: 'Synology DS224', brand: 'Synology', productUrl: '' }]);
    expect(out[0].productUrl).toBe('https://www.amazon.com/dp/B0ABCDEFGH');
    expect(out[0].affiliateUrl).toContain('tag=battlesheep0a-20');
  });

  it('leaves product unchanged when the result title does not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      organic: [{ link: 'https://www.amazon.com/dp/B0WRONGONE0', title: 'Completely Unrelated Toaster' }],
    }), { status: 200 })));
    const out = await resolveAsins(ENV, [{ name: 'Synology DS224', brand: 'Synology', productUrl: '' }]);
    expect(out[0].productUrl).toBe('');
  });

  it('swallows a Serper error (product unchanged, no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));
    const out = await resolveAsins(ENV, [{ name: 'Some Product Name', productUrl: '' }]);
    expect(out[0].productUrl).toBe('');
  });
});

describe('image-resolver pure helpers', () => {
  it('buildImageQuery dedups brand + rejects short names', () => {
    expect(buildImageQuery({ name: 'ab' })).toBe('');
    expect(buildImageQuery({ name: 'WH-1000XM5', brand: 'Sony' })).toBe('Sony WH-1000XM5 product');
    expect(buildImageQuery({ name: 'Sony WH-1000XM5', brand: 'Sony' })).toBe('Sony WH-1000XM5 product');
  });

  it('pickBestImage filters junk and prefers product CDNs', () => {
    expect(pickBestImage(null)).toBe('');
    expect(pickBestImage([{ imageUrl: 'https://x/tiny.jpg', imageWidth: 50, imageHeight: 50 }])).toBe('');
    expect(pickBestImage([{ imageUrl: 'https://x/banner.jpg', imageWidth: 1200, imageHeight: 100 }])).toBe(''); // extreme aspect
    const best = pickBestImage([
      { imageUrl: 'https://blog.example/photo.jpg', imageWidth: 800, imageHeight: 800 },
      { imageUrl: 'https://m.media-amazon.com/images/p.jpg', imageWidth: 500, imageHeight: 500 },
    ]);
    expect(best).toContain('media-amazon.com'); // preferred host wins
  });

  it('upgrades http → https', () => {
    expect(pickBestImage([{ imageUrl: 'http://x/p.jpg', imageWidth: 400, imageHeight: 400 }])).toBe('https://x/p.jpg');
  });
});

describe('resolveImages', () => {
  it('no key → unchanged', async () => {
    const out = await resolveImages({}, [{ name: 'X' }]);
    expect(out[0].imageUrl).toBeUndefined();
  });

  it('skips products that already have an https image', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await resolveImages(ENV, [{ name: 'X', imageUrl: 'https://cdn/x.jpg' }]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fills a missing image from Serper Images', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      images: [{ imageUrl: 'https://m.media-amazon.com/images/p.jpg', imageWidth: 600, imageHeight: 600 }],
    }), { status: 200 })));
    const out = await resolveImages(ENV, [{ name: 'Synology DS224', brand: 'Synology' }]);
    expect(out[0].imageUrl).toContain('media-amazon.com');
  });
});

describe('resolveImages Brave fallback', () => {
  const BRAVE_ENV = { BRAVE_API_KEY: 'brave-key' };
  const product = { name: 'Synology DS224', brand: 'Synology' };

  it('no Serper key + Brave key → Brave Image Search sets the image', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { properties: { url: 'http://blog.example/p.jpg', width: 600, height: 600 } },
        { properties: { url: 'https://m.media-amazon.com/images/ds224.jpg', width: 500, height: 500 } },
      ],
    }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages(BRAVE_ENV, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    const u = new URL(url);
    expect(`${u.host}${u.pathname}`).toBe('api.search.brave.com/res/v1/images/search');
    expect(u.searchParams.get('q')).toBe('Synology DS224 product');
    expect(u.searchParams.get('count')).toBe('5');
    expect(init.headers['X-Subscription-Token']).toBe('brave-key');
    expect(out[0].imageUrl).toBe('https://m.media-amazon.com/images/ds224.jpg');
    expect(product.imageUrl).toBeUndefined();
  });

  it('both keys → Serper only', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({
      images: [{ imageUrl: 'https://m.media-amazon.com/images/p.jpg', imageWidth: 600, imageHeight: 600 }],
    }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages({ ...ENV, BRAVE_API_KEY: 'brave-key' }, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new URL(spy.mock.calls[0][0]).host).toBe('google.serper.dev');
    expect(out[0].imageUrl).toContain('media-amazon.com');
  });

  it('no keys → untouched, no request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages({}, [product]);
    expect(spy).not.toHaveBeenCalled();
    expect(out[0]).toBe(product);
  });

  it('Brave image 403 → untouched, no throw, one log, later products skipped', async () => {
    const spy = vi.fn(async () => new Response('forbidden', { status: 403 }));
    vi.stubGlobal('fetch', spy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const products = [product, { name: 'Sony WH-1000XM5', brand: 'Sony' }];
    const out = await resolveImages(BRAVE_ENV, products);
    expect(out).toEqual(products);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([m]) => String(m).includes('brave images HTTP 403'))).toHaveLength(1);
    log.mockRestore();
  });

  it('braveImagesToSerperShape falls back to thumbnail fields', () => {
    expect(braveImagesToSerperShape(null)).toEqual([]);
    expect(braveImagesToSerperShape([{ thumbnail: { src: 'https://imgs.search.brave.com/t.jpg', width: 500, height: 400 } }]))
      .toEqual([{ imageUrl: 'https://imgs.search.brave.com/t.jpg', imageWidth: 500, imageHeight: 400 }]);
  });
});

describe('resolveImages SearXNG images', () => {
  const SEARX_URL = 'https://searx.example.test/';
  const GATE = 'gate-abc';
  const SEARX_ENV = { SEARXNG_URL: SEARX_URL, LITELLM_GATE_TOKEN: GATE };
  const AMAZON_IMG = 'https://m.media-amazon.com/images/ds224.jpg';
  const BRAVE_IMG = 'https://m.media-amazon.com/images/brave-ds224.jpg';
  const product = { name: 'Synology DS224', brand: 'Synology' };
  const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200 });
  const searxResults = (results) => jsonResponse({ results });
  const silenceLogs = () => vi.spyOn(console, 'log').mockImplementation(() => {});

  afterEach(() => vi.restoreAllMocks());

  it('no Serper key + SEARXNG_URL → gated image search ranks and sets the image', async () => {
    silenceLogs();
    const spy = vi.fn(async () => searxResults([
      { img_src: 'https://blog.example/p.jpg', resolution: '800×800' },
      { img_src: AMAZON_IMG, resolution: '1500 x 1500' },
      { img_src: '', resolution: '900x900' },
    ]));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages(SEARX_ENV, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    const u = new URL(url);
    expect(u.host).toBe('searx.example.test');
    expect(u.pathname).toBe('/search');
    expect(u.searchParams.get('q')).toBe('Synology DS224 product');
    expect(u.searchParams.get('format')).toBe('json');
    expect(u.searchParams.get('categories')).toBe('images');
    expect(init.headers['X-Edge-Gate']).toBe(GATE);
    expect(out[0].imageUrl).toBe(AMAZON_IMG);
    expect(product.imageUrl).toBeUndefined();
  });

  it('no gate token → no X-Edge-Gate header', async () => {
    silenceLogs();
    const spy = vi.fn(async () => searxResults([{ img_src: AMAZON_IMG, resolution: '600x600' }]));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages({ SEARXNG_URL: SEARX_URL }, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, init] = spy.mock.calls[0];
    expect(Object.keys(init.headers)).not.toContain('X-Edge-Gate');
    expect(out[0].imageUrl).toBe(AMAZON_IMG);
  });

  it('results without a resolution are dropped by pickBestImage', async () => {
    silenceLogs();
    const spy = vi.fn(async () => searxResults([{ img_src: 'https://x/p.jpg' }]));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages(SEARX_ENV, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0].imageUrl).toBeUndefined();
  });

  it('SearXNG HTTP 500 + Brave key → that query retries on Brave Image Search', async () => {
    silenceLogs();
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ properties: { url: BRAVE_IMG, width: 600, height: 600 } }],
      }));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages({ ...SEARX_ENV, BRAVE_API_KEY: 'brave-key' }, [product]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new URL(spy.mock.calls[0][0]).host).toBe('searx.example.test');
    const brave = new URL(spy.mock.calls[1][0]);
    expect(`${brave.host}${brave.pathname}`).toBe('api.search.brave.com/res/v1/images/search');
    expect(out[0].imageUrl).toBe(BRAVE_IMG);
  });

  it('SearXNG HTTP 500 + no Brave key → untouched, one request, no throw', async () => {
    silenceLogs();
    const spy = vi.fn(async () => new Response('boom', { status: 500 }));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages(SEARX_ENV, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(out[0]).toEqual(product);
    expect(out[0].imageUrl).toBeUndefined();
  });

  it('Serper key + SEARXNG_URL → Serper only', async () => {
    const spy = vi.fn(async () => jsonResponse({
      images: [{ imageUrl: AMAZON_IMG, imageWidth: 600, imageHeight: 600 }],
    }));
    vi.stubGlobal('fetch', spy);
    const out = await resolveImages({ ...ENV, ...SEARX_ENV }, [product]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(new URL(spy.mock.calls[0][0]).host).toBe('google.serper.dev');
    expect(out[0].imageUrl).toBe(AMAZON_IMG);
  });

  it('searxngImageSearch: empty baseUrl → null, no request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await searxngImageSearch('Synology DS224 product', '')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('searxngImageSearch: bad JSON → null', async () => {
    silenceLogs();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json{', { status: 200 })));
    expect(await searxngImageSearch('Synology DS224 product', SEARX_URL)).toBeNull();
  });

  it('searxngImageSearch: zero results → []', async () => {
    silenceLogs();
    vi.stubGlobal('fetch', vi.fn(async () => searxResults([])));
    expect(await searxngImageSearch('Synology DS224 product', SEARX_URL)).toEqual([]);
  });

  it('searxngImageSearch: maps results to the Serper image shape in order', async () => {
    silenceLogs();
    vi.stubGlobal('fetch', vi.fn(async () => searxResults([
      { img_src: 'https://blog.example/p.jpg', resolution: '800×800' },
      { img_src: '', resolution: '900x900' },
      { resolution: '900x900' },
      { img_src: AMAZON_IMG },
    ])));
    expect(await searxngImageSearch('Synology DS224 product', SEARX_URL)).toEqual([
      { imageUrl: 'https://blog.example/p.jpg', imageWidth: 800, imageHeight: 800 },
      { imageUrl: AMAZON_IMG, imageWidth: 0, imageHeight: 0 },
    ]);
  });
});

describe('parseResolution', () => {
  const ZERO = { width: 0, height: 0 };

  it('parses W×H strings in the separators SearXNG engines use', () => {
    expect(parseResolution('1000×1000')).toEqual({ width: 1000, height: 1000 });
    expect(parseResolution('1200x1050')).toEqual({ width: 1200, height: 1050 });
    expect(parseResolution('3000 x 3000')).toEqual({ width: 3000, height: 3000 });
    expect(parseResolution('1500 X 851')).toEqual({ width: 1500, height: 851 });
  });

  it('anything else → zero size', () => {
    for (const value of [null, undefined, 1000, '', 'abc', '0x0']) {
      expect(parseResolution(value)).toEqual(ZERO);
    }
  });
});
