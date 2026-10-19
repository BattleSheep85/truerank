// Unit tests for worker/engine/extract/critical-excerpts.js (CP-399): verbatim low-star
// review quotes with source and star attribution, for the "rated it low" block.
import { criticalExcerpts, attachCriticalReviews, starsIn } from '../../worker/engine/extract/critical-excerpts.js';

const src = (url, title, content, tags = ['user-review']) => ({ url, title, content, credibility: { score: 60, tags } });

export function runCriticalExcerptsTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // ── star detection ────────────────────────────────────────────────────────
  eq('1/5 reads as 1 star', starsIn('I gave the Acme X1 a 1/5 after it died.'), 1);
  eq('"2 out of 5" reads as 2 stars', starsIn('Two weeks in, 2 out of 5 from me.'), 2);
  eq('"one-star" reads as 1 star', starsIn('Leaving a one-star review for this kettle.'), 1);
  eq('"2 stars" reads as 2 stars', starsIn('2 stars because the lid leaks.'), 2);
  eq('"1.5 stars" reads as 1.5', starsIn('Rated 1.5 stars by most buyers.'), 1.5);
  eq('star glyphs read as their count', starsIn('★★☆☆☆ The handle snapped.'), 2);
  eq('"4.1 stars" is not low', starsIn('It holds 4.1 stars on Amazon.'), null);
  eq('"5 stars" is not low', starsIn('5 stars, love it.'), null);
  eq('"2 stars out of 10" is not out of 5', starsIn('I give it 2 out of 10.'), null);
  eq('a carousel counter "1 / 5" is not a rating', starsIn('1 / 5 Bench Performance Database'), null);
  eq('no rating → null', starsIn('The lid leaks after a week.'), null);

  // ── excerpt picking ───────────────────────────────────────────────────────
  const sources = [
    src('https://www.reddit.com/r/coffee/comments/abc', 'Acme Kettle Pro owners: honest thoughts?',
      'Mine lasted three months. 1 star from me: the Acme Kettle Pro lid hinge snapped and support never replied. Otherwise it boils fast.'),
    src('https://example.com/kettles', 'Best electric kettles',
      'The Acme Kettle Pro is great. The Zed Boil 2 got a 2/5 from our tester because the base wobbles.', ['expert-review']),
    src('https://brand.example/acme', 'Acme Kettle Pro', 'Some buyer gave the Acme Kettle Pro 1/5 for shipping damage.', ['manufacturer']),
    src('http://insecure.example/r', 'Acme Kettle Pro review', 'Acme Kettle Pro gets 2 stars: it rattles at full boil and the cord is short.'),
  ];
  const acme = criticalExcerpts('Acme Kettle Pro', sources, ['Zed Boil 2']);
  eq('finds one excerpt for Acme', acme.length, 1);
  eq('quote is verbatim from the source', sources[0].content.includes(acme[0]?.quote), true);
  eq('quote carries the star count', acme[0]?.stars, 1);
  eq('quote carries the source url', acme[0]?.sourceUrl, 'https://www.reddit.com/r/coffee/comments/abc');
  eq('quote carries the source title', acme[0]?.sourceTitle, 'Acme Kettle Pro owners: honest thoughts?');
  eq('a rival\'s low score is not given to Acme', acme.some((x) => /Zed/.test(x.quote)), false);
  eq('manufacturer pages are skipped', acme.some((x) => /shipping/.test(x.quote)), false);
  eq('non-https sources are skipped', acme.some((x) => /rattles/.test(x.quote)), false);

  const zed = criticalExcerpts('Zed Boil 2', sources, ['Acme Kettle Pro']);
  eq('Zed gets its own 2/5 quote', zed.length === 1 && zed[0].stars === 2, true);

  // A star sentence without the name counts only on a page about that one product.
  const pageAbout = [src('https://www.reddit.com/r/x/1', 'Acme Kettle Pro after a year', 'It looked nice at first. 2 stars. The lid hinge cracked in month four and the warranty was refused.')];
  const about = criticalExcerpts('Acme Kettle Pro', pageAbout, []);
  eq('page about one product: unnamed star sentence counts', about.length, 1);
  eq('a short star sentence takes the next sentence as its reason', /hinge cracked/.test(about[0]?.quote || ''), true);
  const pageMixed = [src('https://www.reddit.com/r/x/2', 'Acme Kettle Pro vs Zed Boil 2', '2 stars. The lid hinge cracked in month four.')];
  eq('page about two products: unnamed star sentence is skipped', criticalExcerpts('Acme Kettle Pro', pageMixed, ['Zed Boil 2']).length, 0);

  // Caps and de-duplication.
  const many = [1, 2, 3].map((i) => src(`https://www.reddit.com/r/x/${i}`, 'Kettles', `Acme Kettle Pro gets 1 star from me, reason number ${i} is the leaking lid.`));
  many.push(src('https://www.reddit.com/r/x/9', 'Kettles', 'Acme Kettle Pro gets 1 star from me, reason number 1 is the leaking lid.'));
  eq('at most 2 excerpts per product', criticalExcerpts('Acme Kettle Pro', many, []).length, 2);
  eq('duplicate quotes are dropped', new Set(criticalExcerpts('Acme Kettle Pro', many, [], 5).map((x) => x.quote)).size, 3);

  // ── attachCriticalReviews (immutable) ───────────────────────────────────
  const rep = { products: [{ name: 'Acme Kettle Pro', rating: 3.2 }, { name: 'Zed Boil 2', rating: 4.6 }] };
  const out = attachCriticalReviews(rep, sources);
  eq('attach returns a new report', out !== rep && rep.products[0].criticalReviews === undefined, true);
  eq('attach adds quotes to each product', out.products[0].criticalReviews.length, 1);
  eq('attach adds quotes for a high-rated product too', out.products[1].criticalReviews.length, 1);
  eq('attach with no sources leaves empty lists', attachCriticalReviews(rep, []).products[0].criticalReviews, []);
  eq('attach tolerates a bad report', attachCriticalReviews(null, sources), null);

  return report;
}
