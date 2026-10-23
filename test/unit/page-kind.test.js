// CP-803: local, experience and service pages never show Amazon buttons. The classifier
// marks "coffee shops in Brooklyn" as is_experience + needs_location, not is_service,
// and legacy rows carry no sold_on_amazon facet, so the page must read those facets too.
import { isPlaceOrExperience, isAmazonViable, pageKind } from '../../worker/lib/page-kind.js';
import { resolveProductCtas } from '../../worker/pages/research-primitives.js';

const COFFEE = { needs_location: true, is_buyable: false, is_experience: true, is_content: false, is_service: false, is_comparative: false };
const HIKES = { needs_location: true, is_buyable: false, is_experience: true, is_service: false };
const PARKS = { needs_location: false, is_buyable: false, is_experience: true, is_service: false };
const PRODUCT = { needs_location: false, is_buyable: true, is_experience: false, is_service: false, sold_on_amazon: true };
const LOCAL_PRODUCT = { needs_location: true, is_buyable: true, is_experience: false, is_service: false };

export function runPageKindTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  eq('coffee shops are a place', isPlaceOrExperience(COFFEE), true);
  eq('winter national parks are an experience', isPlaceOrExperience(PARKS), true);
  eq('a local non-buyable query is a place', isPlaceOrExperience({ needs_location: true }), true);
  eq('a buyable product bought locally is not a place', isPlaceOrExperience(LOCAL_PRODUCT), false);
  eq('a plain product is not a place', isPlaceOrExperience(PRODUCT), false);
  eq('a buyable product for a trip is not a place', isPlaceOrExperience({ is_buyable: true, is_experience: true }), false);
  eq('missing facets are not a place', isPlaceOrExperience(null), false);

  eq('Amazon not viable for coffee shops', isAmazonViable(COFFEE), false);
  eq('Amazon not viable for a service', isAmazonViable({ is_service: true }), false);
  eq('Amazon not viable when the classifier says so', isAmazonViable({ sold_on_amazon: false }), false);
  eq('Amazon viable for a product', isAmazonViable(PRODUCT), true);
  eq('Amazon viable for legacy rows without facets', isAmazonViable(undefined), true);

  eq('coffee shops render as a service page', pageKind('coffee shops in Brooklyn', COFFEE), { isService: true, webOnly: false });
  eq('day hikes render as a service page', pageKind('day hikes near Denver', HIKES), { isService: true, webOnly: false });
  eq('category hint still makes a service page', pageKind('Real Estate Agents', {}), { isService: true, webOnly: false });
  eq('is_service still makes a service page', pageKind('wedding photographer', { is_service: true }), { isService: true, webOnly: false });
  eq('sold_on_amazon false is web-only', pageKind('lumber', { sold_on_amazon: false }), { isService: false, webOnly: true });
  eq('a product page keeps Amazon', pageKind('robot vacuums', PRODUCT), { isService: false, webOnly: false });
  eq('null facets are a product page', pageKind('robot vacuums', null), { isService: false, webOnly: false });

  const shop = { id: 'x1', name: 'Devoción', brand: '', product_url: '' };
  const { isService, webOnly } = pageKind('coffee shops in Brooklyn', COFFEE);
  const ctas = resolveProductCtas(shop, { amazonTag: 'frank-20' }, isService, 'best-coffee-shops-in-brooklyn', false, webOnly);
  eq('no Amazon button for a coffee shop', ctas.amazon.url, '');
  eq('coffee shop gets a Google hand-off instead', ctas.google.label, 'Find on Google');

  return report;
}
