// CP-399: the "Why some reviewers rated it low" block shows verbatim 1-2★ quotes with
// their source and star count, ahead of the summarized cons.
import { renderProduct, renderOurPick } from '../../worker/pages/research-cards.js';
import { criticalReviewsFromResult } from '../../worker/pages/research-page.js';

const base = (over = {}) => ({
  id: 'p1', name: 'Acme Kettle Pro', brand: 'Acme', rating: 3.2, rank: 1, price: null,
  pros: ['Boils fast.'], cons: ['The lid is loose.', 'The cord is short.', 'It rattles.'],
  specs: {}, metadata: {}, verdict: 'A fast kettle with a weak lid.', ...over,
});
const quote = { quote: 'Acme Kettle Pro gets 1 star from me: the <b>lid</b> hinge snapped.', stars: 1, sourceUrl: 'https://www.reddit.com/r/coffee/comments/abc', sourceTitle: 'Acme owners thread' };

export function runCriticalRenderTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ids = {};

  const html = renderProduct(base({ critical_reviews: [quote] }), 0, ids, false, 'acme', false, false);
  eq('quote is shown', html.includes('the &lt;b&gt;lid&lt;/b&gt; hinge snapped'), true);
  eq('quote text is escaped', html.includes('<b>lid</b>'), false);
  eq('star count is shown', html.includes('1/5'), true);
  eq('source link is shown', html.includes('href="https://www.reddit.com/r/coffee/comments/abc"'), true);
  eq('source link is nofollow and opens in a new tab', /href="https:\/\/www\.reddit\.com\/r\/coffee\/comments\/abc" target="_blank" rel="noopener noreferrer nofollow"/.test(html), true);
  eq('source title is shown', html.includes('Acme owners thread'), true);
  eq('quotes come before the summarized cons', html.indexOf('hinge snapped') < html.indexOf('The cord is short.'), true);
  eq('summarized cons still shown', html.includes('The cord is short.'), true);

  const noQuote = renderProduct(base(), 0, ids, false, 'acme', false, false);
  eq('without quotes the block keeps the cons', noQuote.includes('The cord is short.') && !noQuote.includes('crit-quote'), true);

  const bad = renderProduct(base({ critical_reviews: [{ ...quote, sourceUrl: 'javascript:alert(1)' }] }), 0, ids, false, 'acme', false, false);
  eq('an unsafe source url is never linked', bad.includes('javascript:'), false);

  const high = renderProduct(base({ rating: 4.5, critical_reviews: [quote] }), 0, ids, false, 'acme', false, false);
  eq('4★+ products keep the normal cons grid, no block', high.includes('critical-reviews'), false);

  const pick = renderOurPick(base({ critical_reviews: [quote] }), ids, false, 'acme', false, false, null);
  eq('Our pick box shows the quote too', pick.includes('hinge snapped'), true);

  // Reading the quotes back from research.result for the products table rows.
  const result = { products: [{ name: 'Acme Kettle Pro', criticalReviews: [quote] }, { name: 'Zed Boil 2' }] };
  const map = criticalReviewsFromResult(result);
  eq('result map finds quotes by name', map.get('acme kettle pro'), [quote]);
  eq('result map skips products without quotes', map.has('zed boil 2'), false);
  eq('result map tolerates a bad result', criticalReviewsFromResult(null).size, 0);

  return report;
}
