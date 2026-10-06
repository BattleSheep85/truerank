// Full-coverage assertions for the remaining small pure modules:
// status.js, guides.js, engine-config.js, ads.js, html.js's pure helpers + layout(),
// and product-link.js.
import { apiStatus } from '../../worker/lib/status.js';
import { STATIC_GUIDES, STATIC_GUIDE_SLUGS, GUIDES_LASTMOD } from '../../worker/lib/guides.js';
import { ENGINE_CONFIG } from '../../worker/lib/engine-config.js';
import { adSlot } from '../../worker/lib/ads.js';
import { html, raw, jsonForScript, jsonLdScript, layout } from '../../worker/lib/html.js';
import { searchBar } from '../../worker/lib/search-bar.js';
import { screenQuery, rejectionMessage } from '../../worker/lib/safety.js';
import { buildResearchSeo } from '../../worker/pages/research-jsonld.js';
import {
  PRODUCT_INPUT_MAX_LEN,
  PRODUCT_NAME_MAX_LEN,
  VERIFY_KEY_PREFIX,
  parseProductInput,
  productNameKey,
} from '../../worker/lib/product-link.js';

export function runLibPureTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // status.js
  eq('apiStatus complete', apiStatus('complete'), 'completed');
  eq('apiStatus failed', apiStatus('failed'), 'error');
  eq('apiStatus pending', apiStatus('pending'), 'pending');
  eq('apiStatus processing', apiStatus('processing'), 'processing');

  // guides.js
  eq('guides count', STATIC_GUIDES.length, 4);
  ok('guide slug set', STATIC_GUIDE_SLUGS.has('synology-vs-qnap'));
  eq('guides lastmod', GUIDES_LASTMOD, '2026-06-09');

  // engine-config.js
  eq('engine config synth model', ENGINE_CONFIG.synthModel, 'minimax/minimax-m3');

  // ads.js
  eq('adSlot no publisher → ""', adSlot({}, 'top', 'Ad'), '');
  eq('adSlot no slot → ""', adSlot({ ADSENSE_PUBLISHER_ID: 'pub-1' }, 'top', 'Ad'), '');
  {
    const env = { ADSENSE_PUBLISHER_ID: 'pub-1', ADSENSE_SLOT_TOP: 'T', ADSENSE_SLOT_MID: 'M', ADSENSE_SLOT_BOTTOM: 'B' };
    ok('adSlot top renders slot', adSlot(env, 'top', 'Ad').includes('data-ad-slot="T"'));
    ok('adSlot mid renders slot', adSlot(env, 'mid', 'Ad').includes('data-ad-slot="M"'));
    ok('adSlot bottom renders slot', adSlot(env, 'bottom', 'Ad').includes('data-ad-slot="B"'));
    ok('adSlot escapes label', adSlot(env, 'top', '<x>').includes('&lt;x&gt;'));
  }

  // html.js — tagged template + helpers
  eq('html escapes interpolation', html`<b>${'<x>'}</b>`, '<b>&lt;x&gt;</b>');
  eq('html passes raw branded', html`a${raw('<b>')}c`, 'a<b>c');
  eq('html joins arrays (raw + escaped)', html`${[raw('<i>'), '<x>']}`, '<i>&lt;x&gt;');
  eq('html null → empty', html`a${null}b`, 'ab');
  eq('raw brand', raw('<b>').__html, '<b>');
  ok('jsonLdScript escapes <', jsonLdScript({ a: '</script>' }).includes('\\u003c/script\\u003e'));
  ok('jsonForScript escapes closing script tag', jsonForScript('</script><script>').includes('\\u003c/script\\u003e'));
  ok('jsonForScript escapes &', jsonForScript('rock & roll').includes('rock \\u0026 roll'));

  // html.js layout() — exercise the meta branches + capDescription
  {
    const longSpaced = 'word '.repeat(50); // >155, has spaces past index 100
    const out = layout('Title', longSpaced, '<main>x</main>', '<style>x</style>', {
      ogType: 'article', ogUrl: 'https://x/y', canonical: 'https://x/c', noindex: true, ogImage: 'https://cdn/x.svg',
      article: { publishedTime: '2026-01-01', modifiedTime: '2026-01-02', author: 'A', section: 'Tech', tags: ['t1', 't2'] },
    });
    ok('layout title', out.includes('<title>Title | Frank</title>'));
    ok('layout canonical', out.includes('rel="canonical" href="https://x/c"'));
    ok('layout noindex', out.includes('name="robots" content="noindex,follow"'));
    ok('layout article meta', out.includes('article:published_time') && out.includes('article:tag'));
    ok('layout svg image type', out.includes('og:image:type" content="image/svg+xml"'));
    ok('layout caps long description with ellipsis', out.includes('…'));
  }
  {
    // relative ogImage gets host prepended; png type; no-space long desc branch.
    const noSpace = 'a'.repeat(160);
    const out = layout('T', noSpace, 'b', '', { ogImage: '/og.png' });
    ok('layout relative image prepended', out.includes('https://chrisputer.tech/og.png'));
    ok('layout png image type', out.includes('og:image:type" content="image/png"'));
    ok('layout no canonical when absent', !out.includes('rel="canonical"'));
  }

  // search-bar.js — both sizes render a form with the right placeholder.
  {
    const large = searchBar('large');
    const small = searchBar('small');
    ok('searchBar large placeholder', large.includes('What product are you researching?'));
    ok('searchBar small placeholder', small.includes('Research a product...'));
    ok('searchBar has a form', large.includes('class="search-form"') || large.includes('search-form'));
  }

  // safety.js — screenQuery chokepoint. The deterministic QUERY injection screen
  // was REMOVED 2026-07-08 (false-positived on real product searches); these guard
  // that legit queries stay allowed and only true adult/illegal content is blocked.
  ok('safety allows normal product query', !screenQuery('best mechanical keyboard under 150').blocked);
  ok('safety allows prompt-manager query', !screenQuery('best system prompt manager for teams').blocked);
  ok('safety allows ignore-noise query', !screenQuery('best earplugs to ignore loud coworkers').blocked);
  ok('safety does NOT block a benign query mentioning instructions', !screenQuery('best laptop, ignore the previous model please').blocked);
  ok('safety does NOT block "developer mode" queries', !screenQuery('best android phone with developer mode').blocked);
  eq('safety blocks illegal', screenQuery('how to make counterfeit money').reason, 'illegal');
  ok('safety empty query is allowed (not blocked)', !screenQuery('').blocked);

  // research-jsonld.js: priceValidUntil is rolling and in the future
  {
    const today = new Date().toISOString().split('T')[0];
    const seo = buildResearchSeo({
      entry: { status: 'complete', created_at: 1000000, query: 'best nas' },
      products: [{ name: 'NAS Pro', price: 299, product_url: 'https://www.amazon.com/dp/B0TEST1234', pros: [] }],
      affiliateIds: {},
      pageUrl: 'https://chrisputer.tech/research/best-nas',
      displayTitle: 'Best NAS',
      lastModifiedTs: 1000000,
      hasBuyersGuide: false,
      buyersGuide: null,
      isService: false,
    });
    const match = seo.structuredData.match(/"priceValidUntil":"([^"]+)"/);
    ok('priceValidUntil found in structuredData', !!match);
    if (match) {
      ok('priceValidUntil is in the future', match[1] > today);
    }
  }

  // product-link.js
  runProductLinkTests(eq, ok);

  return report;
}

// product-link.js (refocus 2026-10, plan piece 10): what a person pastes into
// the Verify box becomes { kind, name, url, key }. Fields compare one by one,
// so the key order of the result does not matter.
const PRODUCT_LINK_CASES = [
  ['typed name', 'Sony WH-1000XM6',
    { kind: 'name', name: 'Sony WH-1000XM6', url: null, key: 'verify:name:1000xm6 sony wh' }],
  ['typed name, other word order', 'WH-1000XM6 sony',
    { kind: 'name', url: null, key: 'verify:name:1000xm6 sony wh' }],
  ['amazon long link', 'https://www.amazon.com/Sony-WH-1000XM6-Cancelling-Headphones/dp/B0F3PT1VBL/ref=sr_1_1?crid=X&th=1',
    { kind: 'url', name: 'Sony WH 1000XM6 Cancelling Headphones', url: 'https://www.amazon.com/dp/B0F3PT1VBL', key: 'verify:asin:B0F3PT1VBL' }],
  ['amazon lowercase asin', 'https://www.amazon.com/dp/b0f3pt1vbl',
    { kind: 'url', name: null, url: 'https://www.amazon.com/dp/B0F3PT1VBL', key: 'verify:asin:B0F3PT1VBL' }],
  ['amazon.co.uk gp/product', 'https://www.amazon.co.uk/gp/product/B0F3PT1VBL',
    { kind: 'url', url: 'https://www.amazon.co.uk/dp/B0F3PT1VBL', key: 'verify:asin:B0F3PT1VBL' }],
  ['best buy http link with query', 'http://www.bestbuy.com/site/sony-wh1000xm6-wireless-headphones/6612345.p?skuId=6612345',
    { kind: 'url', name: 'sony wh1000xm6 wireless headphones',
      url: 'https://www.bestbuy.com/site/sony-wh1000xm6-wireless-headphones/6612345.p',
      key: 'verify:url:bestbuy.com/site/sony-wh1000xm6-wireless-headphones/6612345.p' }],
  ['share text with a.co link', 'Sony WH-1000XM6 https://a.co/d/abc123',
    { kind: 'url', name: 'Sony WH-1000XM6', url: 'https://a.co/d/abc123', key: 'verify:name:1000xm6 sony wh' }],
  ['bare a.co link', 'https://a.co/d/abc123',
    { kind: 'url', name: null, url: 'https://a.co/d/abc123', key: null }],
  ['private IP link', 'https://192.168.1.10/product',
    { kind: 'url', name: null, url: null, key: null }],
  ['trailing ) after a link', 'see https://example.com/p/widget-pro-max)',
    { kind: 'url', url: 'https://example.com/p/widget-pro-max' }],
  ['javascript: scheme is not a link', 'javascript:alert(1)',
    { kind: 'name' }],
  ['empty input', '',
    { kind: 'name', name: null, url: null, key: null }],
  ['review: fake amazon host', 'https://www.amazon.com.attacker.io/Some-Product-Name/dp/B0AAAAAAAA',
    { kind: 'url', name: 'Some Product Name',
      url: 'https://www.amazon.com.attacker.io/Some-Product-Name/dp/B0AAAAAAAA',
      key: 'verify:url:amazon.com.attacker.io/some-product-name/dp/b0aaaaaaaa' }],
  ['review: fake amazon host, look-alike domain', 'https://evilamazon.com/dp/B0AAAAAAAA',
    { kind: 'url', key: 'verify:url:evilamazon.com/dp/b0aaaaaaaa' }],
  ['review: fake amazon host, unknown amazon tld', 'https://www.amazon.attacker/dp/B0AAAAAAAA',
    { kind: 'url', key: 'verify:url:amazon.attacker/dp/b0aaaaaaaa' }],
  ['review: fake amazon host, real smile subdomain', 'https://smile.amazon.com/dp/B0F3PT1VBL',
    { kind: 'url', url: 'https://smile.amazon.com/dp/B0F3PT1VBL', key: 'verify:asin:B0F3PT1VBL' }],
  ['review: fake amazon host, real bare amazon.com.mx', 'https://amazon.com.mx/dp/B0F3PT1VBL',
    { kind: 'url', key: 'verify:asin:B0F3PT1VBL' }],
  ['review: query-identified product', 'https://item.taobao.com/item.htm?id=111',
    { kind: 'url', name: null, url: 'https://item.taobao.com/item.htm?id=111',
      key: 'verify:url:item.taobao.com/item.htm?id=111' }],
  ['review: query-identified product, tracking removed and sorted',
    'https://item.taobao.com/item.htm?utm_source=x&spm=a1&id=111&fbclid=z&ref=abc&gclid=q&UTM_Medium=y#reviews',
    { kind: 'url', url: 'https://item.taobao.com/item.htm?id=111&spm=a1',
      key: 'verify:url:item.taobao.com/item.htm?id=111&spm=a1' }],
  ['review: query-identified product, only tracking params', 'https://item.taobao.com/item.htm?utm_source=x',
    { kind: 'url', url: 'https://item.taobao.com/item.htm', key: 'verify:url:item.taobao.com/item.htm' }],
  ['review: extra links stripped from name', 'Great https://amzn.to/xyz http://169.254.169.254/latest',
    { kind: 'url', name: 'Great', url: 'https://amzn.to/xyz', key: 'verify:name:great' }],
  ['review: extra links stripped from name, link before and after', 'https://a.co/d/abc123 Sony WH-1000XM6 https://evil.example/x?y=1',
    { kind: 'url', name: 'Sony WH-1000XM6', key: 'verify:name:1000xm6 sony wh' }],
];

function runProductLinkTests(eq, ok) {
  eq('PRODUCT_INPUT_MAX_LEN', PRODUCT_INPUT_MAX_LEN, 2048);
  eq('PRODUCT_NAME_MAX_LEN', PRODUCT_NAME_MAX_LEN, 200);
  eq('VERIFY_KEY_PREFIX', VERIFY_KEY_PREFIX, 'verify:');

  for (const [label, input, expected] of PRODUCT_LINK_CASES) {
    const out = parseProductInput(input);
    for (const [field, value] of Object.entries(expected)) {
      eq(`parseProductInput ${label}: ${field}`, out ? out[field] : out, value);
    }
  }

  const air2024 = parseProductInput('MacBook Air 2024').key;
  const air2022 = parseProductInput('MacBook Air 2022').key;
  ok('MacBook Air 2024 has a key', typeof air2024 === 'string');
  ok('MacBook Air 2024 and 2022 keys differ', air2024 !== air2022);
  ok('trailing ) is gone from url', !String(parseProductInput('see https://example.com/p/widget-pro-max)').url).includes(')'));

  const longName = parseProductInput('a'.repeat(PRODUCT_NAME_MAX_LEN + 50)).name;
  eq('typed name is capped at PRODUCT_NAME_MAX_LEN', longName ? longName.length : longName, PRODUCT_NAME_MAX_LEN);

  eq('productNameKey sorts unique lowercase tokens', productNameKey('Sony WH-1000XM6 sony'), 'verify:name:1000xm6 sony wh');
  eq('productNameKey with no token → null', productNameKey('!!! ---'), null);
  eq('productNameKey empty → null', productNameKey(''), null);

  ok('parseProductInput result is frozen', Object.isFrozen(parseProductInput('Sony WH-1000XM6')));
  ok('parseProductInput url result is frozen', Object.isFrozen(parseProductInput('https://www.amazon.com/dp/B0F3PT1VBL')));

  ok('review: query-identified product, different ids give different keys',
    parseProductInput('https://item.taobao.com/item.htm?id=111').key
      !== parseProductInput('https://item.taobao.com/item.htm?id=222').key);
  ok('review: extra links stripped from name, no metadata host in name',
    !String(parseProductInput('Great https://amzn.to/xyz http://169.254.169.254/latest').name).includes('169.254'));
}
