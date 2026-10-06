// Unit tests for GDPR/ePrivacy consent handling and banner rendering.
import {
  requiresConsent,
  hasAdsConsent,
  hasConsentCookie,
  renderConsentBanner,
  CONSENT_COUNTRIES,
} from '../../worker/lib/consent.js';
import { htmlPageResponse, injectHtml, notFound } from '../../worker/lib/http-response.js';

export async function runConsentTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── requiresConsent ────────────────────────────────────────────────────────
  // True for EEA countries (DE, FR, etc.), UK (GB), Switzerland (CH)
  ok('requiresConsent true for DE', requiresConsent({ cf: { country: 'DE' } }));
  ok('requiresConsent true for FR', requiresConsent({ cf: { country: 'FR' } }));
  ok('requiresConsent true for GB', requiresConsent({ cf: { country: 'GB' } }));
  ok('requiresConsent true for CH', requiresConsent({ cf: { country: 'CH' } }));
  ok('requiresConsent true for IS', requiresConsent({ cf: { country: 'IS' } }));
  ok('requiresConsent true for LI', requiresConsent({ cf: { country: 'LI' } }));
  ok('requiresConsent true for NO', requiresConsent({ cf: { country: 'NO' } }));
  ok('requiresConsent true case-insensitive', requiresConsent({ cf: { country: 'de' } }));

  // False for non-EEA / non-UK / non-CH countries
  ok('requiresConsent false for US', !requiresConsent({ cf: { country: 'US' } }));
  ok('requiresConsent false for CA', !requiresConsent({ cf: { country: 'CA' } }));
  ok('requiresConsent false for AU', !requiresConsent({ cf: { country: 'AU' } }));
  ok('requiresConsent false for JP', !requiresConsent({ cf: { country: 'JP' } }));
  ok('requiresConsent false for BR', !requiresConsent({ cf: { country: 'BR' } }));

  // Missing request.cf / country defaults to true (fail closed to privacy-protective branch)
  ok('requiresConsent true when request.cf is missing', requiresConsent({}));
  ok('requiresConsent true when request is undefined', requiresConsent(undefined));
  ok('requiresConsent true when request is null', requiresConsent(null));
  ok('requiresConsent true when request.cf.country is null', requiresConsent({ cf: { country: null } }));
  ok('requiresConsent true when request.cf.country is empty', requiresConsent({ cf: { country: '' } }));

  // ── hasAdsConsent ──────────────────────────────────────────────────────────
  // Absent cookie / headers
  ok('hasAdsConsent false when request is null', !hasAdsConsent(null));
  ok('hasAdsConsent false when request is undefined', !hasAdsConsent(undefined));
  ok('hasAdsConsent false when headers missing', !hasAdsConsent({}));
  ok('hasAdsConsent false when Cookie header absent', !hasAdsConsent({ headers: new Headers() }));
  ok('hasAdsConsent false when Cookie is empty', !hasAdsConsent({ headers: new Headers({ Cookie: '' }) }));

  // ads_consent=0
  ok('hasAdsConsent false for ads_consent=0', !hasAdsConsent({ headers: new Headers({ Cookie: 'ads_consent=0' }) }));
  ok('hasAdsConsent false for ads_consent=0 among other cookies', !hasAdsConsent({ headers: new Headers({ Cookie: 'theme=dark; ads_consent=0; session=abc' }) }));

  // ads_consent=1
  ok('hasAdsConsent true for ads_consent=1', hasAdsConsent({ headers: new Headers({ Cookie: 'ads_consent=1' }) }));
  ok('hasAdsConsent true for ads_consent=1 among other cookies', hasAdsConsent({ headers: new Headers({ Cookie: 'theme=dark; ads_consent=1; session=abc' }) }));
  ok('hasAdsConsent true for ads_consent=1 with whitespace', hasAdsConsent({ headers: new Headers({ Cookie: 'foo=bar; ads_consent=1 ; baz=qux' }) }));

  // Non-matching substrings
  ok('hasAdsConsent false for other_ads_consent=1', !hasAdsConsent({ headers: new Headers({ Cookie: 'other_ads_consent=1' }) }));
  ok('hasAdsConsent false for ads_consent=2', !hasAdsConsent({ headers: new Headers({ Cookie: 'ads_consent=2' }) }));

  // ── hasConsentCookie ───────────────────────────────────────────────────────
  ok('hasConsentCookie false when absent', !hasConsentCookie({ headers: new Headers() }));
  ok('hasConsentCookie true when ads_consent=0', hasConsentCookie({ headers: new Headers({ Cookie: 'ads_consent=0' }) }));
  ok('hasConsentCookie true when ads_consent=1', hasConsentCookie({ headers: new Headers({ Cookie: 'ads_consent=1' }) }));

  // ── injectHtml shared helper ───────────────────────────────────────────────
  const staticHtml = '<!DOCTYPE html><html><head><script nonce="__CSP_NONCE__">console.log(1)</script></head><body><h1>Home</h1></body></html>';
  const plainHtml = '<!DOCTYPE html><html><head><title>Plain</title></head><body><h1>No Nonce</h1></body></html>';
  const envWithAds = { ADSENSE_PUBLISHER_ID: 'pub-test-12345', CF_ANALYTICS_TOKEN: 'cf-tok-99' };
  const envWithoutAds = {};

  {
    const reqUS = { cf: { country: 'US' }, headers: new Headers() };
    const { html, nonce } = injectHtml(staticHtml, envWithAds, reqUS);
    ok('injectHtml US replaces __CSP_NONCE__', html.includes(`nonce="${nonce}"`));
    ok('injectHtml US does not contain raw placeholder', !html.includes('__CSP_NONCE__'));
    ok('injectHtml US injects AdSense script', html.includes('pagead2.googlesyndication.com'));
    ok('injectHtml US AdSense tag has matching nonce', html.includes(`nonce="${nonce}" src="https://pagead2.googlesyndication.com`));
    ok('injectHtml US injects CF beacon', html.includes('beacon.min.js') && html.includes('cf-tok-99'));
    ok('injectHtml US omits banner', !html.includes('id="consent-banner"'));
  }

  {
    const reqUS = { cf: { country: 'US' }, headers: new Headers() };
    const { html, nonce } = injectHtml(plainHtml, envWithAds, reqUS);
    ok('injectHtml on plain HTML without placeholder gives AdSense matching nonce', html.includes(`nonce="${nonce}" src="https://pagead2.googlesyndication.com`));
  }

  {
    const reqDE = { cf: { country: 'DE' }, headers: new Headers() };
    const { html, nonce } = injectHtml(staticHtml, envWithAds, reqDE);
    ok('injectHtml DE omits AdSense script', !html.includes('pagead2.googlesyndication.com'));
    ok('injectHtml DE includes consent banner with matching nonce', html.includes('id="consent-banner"') && html.includes(`<script nonce="${nonce}">`));
    ok('injectHtml DE includes CF beacon', html.includes('beacon.min.js'));
  }

  // ── htmlPageResponse rendering ─────────────────────────────────────────────
  const testHtml = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';

  // 1. Consent-required visitor without consent cookie:
  // Omits AdSense script, includes banner
  {
    const reqDE = { cf: { country: 'DE' }, headers: new Headers() };
    const res = htmlPageResponse(testHtml, envWithAds, { request: reqDE });
    const text = await res.text();
    ok('DE visitor: omits AdSense script', !text.includes('pagead2.googlesyndication.com'));
    ok('DE visitor: includes consent banner', text.includes('id="consent-banner"'));
    ok('DE visitor: banner includes Accept ads button', text.includes('Accept ads'));
    ok('DE visitor: banner includes Decline button', text.includes('Decline'));
    ok('DE visitor: banner includes accessible role/label', text.includes('role="region"') && text.includes('aria-label="Cookie consent"'));
  }

  // 2. Default/missing request (local dev / fail closed):
  // Omits AdSense script, includes banner
  {
    const res = htmlPageResponse(testHtml, envWithAds);
    const text = await res.text();
    ok('no-request visitor: omits AdSense script', !text.includes('pagead2.googlesyndication.com'));
    ok('no-request visitor: includes consent banner', text.includes('id="consent-banner"'));
  }

  // 3. US visitor (consent not required) with ADSENSE_PUBLISHER_ID set:
  // Includes AdSense script, omits banner
  {
    const reqUS = { cf: { country: 'US' }, headers: new Headers() };
    const res = htmlPageResponse(testHtml, envWithAds, { request: reqUS });
    const text = await res.text();
    ok('US visitor: includes AdSense script with publisher ID', text.includes('src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-test-12345"'));
    ok('US visitor: omits consent banner', !text.includes('id="consent-banner"'));
  }

  // 4. EEA visitor with ads_consent=1 (consent granted) with ADSENSE_PUBLISHER_ID set:
  // Includes AdSense script, omits banner
  {
    const reqDEAccepted = { cf: { country: 'DE' }, headers: new Headers({ Cookie: 'ads_consent=1' }) };
    const res = htmlPageResponse(testHtml, envWithAds, { request: reqDEAccepted });
    const text = await res.text();
    ok('DE visitor with consent=1: includes AdSense script', text.includes('pagead2.googlesyndication.com'));
    ok('DE visitor with consent=1: omits consent banner', !text.includes('id="consent-banner"'));
  }

  // 5. EEA visitor with ads_consent=0 (consent declined) with ADSENSE_PUBLISHER_ID set:
  // Omits AdSense script, omits banner
  {
    const reqDEDeclined = { cf: { country: 'DE' }, headers: new Headers({ Cookie: 'ads_consent=0' }) };
    const res = htmlPageResponse(testHtml, envWithAds, { request: reqDEDeclined });
    const text = await res.text();
    ok('DE visitor with consent=0: omits AdSense script', !text.includes('pagead2.googlesyndication.com'));
    ok('DE visitor with consent=0: omits consent banner', !text.includes('id="consent-banner"'));
  }

  // 6. No ADSENSE_PUBLISHER_ID configured:
  // Omits AdSense script, omits banner
  {
    const reqDE = { cf: { country: 'DE' }, headers: new Headers() };
    const res = htmlPageResponse(testHtml, envWithoutAds, { request: reqDE });
    const text = await res.text();
    ok('No publisher ID: omits AdSense script', !text.includes('pagead2.googlesyndication.com'));
    ok('No publisher ID: omits consent banner', !text.includes('id="consent-banner"'));
  }

  const nf = await notFound('text/html').text();
  ok('404 html title names Frank', nf.includes('<title>404 Not Found | Frank</title>'));
  ok('404 html has no TrueRank brand', !nf.includes('TrueRank'));

  return report;
}
