// Coverage for the post-synthesis resolvers (Serper-backed, fetch mocked):
// asin-resolver (direct /dp link recovery) + image-resolver (product photos).
// Both must NEVER throw and pass unresolved products through unchanged.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { resolveAsins } from '../../worker/lib/asin-resolver.js';
import { resolveImages, buildImageQuery, pickBestImage, braveImagesToSerperShape } from '../../worker/lib/image-resolver.js';

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
