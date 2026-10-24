// Unit tests for the opening book module.
import {
  OPENING_BOOK_TEMPLATES,
  openingBookSubject,
  buildOpeningBookQueries,
  runOpeningBook,
} from '../../worker/engine/opening-book.js';

export async function runOpeningBookTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── 1. OPENING_BOOK_TEMPLATES pinned exactly ─────────────────────────────
  {
    eq('OPENING_BOOK_TEMPLATES length is 4', OPENING_BOOK_TEMPLATES.length, 4);
    eq('OPENING_BOOK_TEMPLATES matches expected template list and order', OPENING_BOOK_TEMPLATES, [
      'best {subject}',
      '{subject} review',
      'best {subject} reddit',
      '{subject} site:reddit.com',
    ]);
  }

  // ── 2. openingBookSubject for comparative / topicalCategory / query fallback / empty ───
  {
    // comparative queries use the raw trimmed query with collapsed whitespace
    eq(
      'comparative query uses raw trimmed query',
      openingBookSubject('  sony wh-1000xm5   vs   bose qc ultra  ', 'headphones', { is_comparative: true }),
      'sony wh-1000xm5 vs bose qc ultra',
    );
    eq(
      'comparative query with empty category',
      openingBookSubject('A   vs   B', '', { is_comparative: true }),
      'A vs B',
    );

    // non-comparative with non-empty topicalCategory
    eq(
      'topicalCategory used when non-empty',
      openingBookSubject('best running shoes 2026', '  running   shoes  ', { is_comparative: false }),
      'running shoes',
    );
    eq(
      'topicalCategory used with undefined facets',
      openingBookSubject('what is the best mattress', 'mattresses', undefined),
      'mattresses',
    );

    // fallback to query when topicalCategory is empty / whitespace / null / undefined
    eq(
      'fallback to query when topicalCategory is empty',
      openingBookSubject('  mechanical   keyboards  ', '', {}),
      'mechanical keyboards',
    );
    eq(
      'fallback to query when topicalCategory is whitespace',
      openingBookSubject('espresso machine', '   ', {}),
      'espresso machine',
    );
    eq(
      'fallback to query when topicalCategory is null',
      openingBookSubject('espresso machine', null, {}),
      'espresso machine',
    );
    eq(
      'fallback to query when topicalCategory is undefined',
      openingBookSubject('espresso machine', undefined, {}),
      'espresso machine',
    );

    // empty input returns ''
    eq('empty query and empty category returns empty string', openingBookSubject('', '', {}), '');
    eq('whitespace-only query and whitespace category returns empty string', openingBookSubject('   ', '   ', {}), '');
    eq('null query and null category returns empty string', openingBookSubject(null, null, {}), '');
    eq('undefined query and undefined category returns empty string', openingBookSubject(undefined, undefined, {}), '');
  }

  // ── 3. buildOpeningBookQueries exact 4 outputs for sample category and [] for empty subject ───
  {
    const queries = buildOpeningBookQueries('best espresso maker', 'espresso machine', {});
    eq('buildOpeningBookQueries returns 4 template queries in order', queries, [
      'best espresso machine',
      'espresso machine review',
      'best espresso machine reddit',
      'espresso machine site:reddit.com',
    ]);

    eq('buildOpeningBookQueries returns empty array for empty subject', buildOpeningBookQueries('', '', {}), []);
    eq('buildOpeningBookQueries returns empty array for null subject', buildOpeningBookQueries(null, null, {}), []);

    // comparative query in buildOpeningBookQueries
    const compQueries = buildOpeningBookQueries('iPhone 16 vs Galaxy S25', 'smartphones', { is_comparative: true });
    eq('buildOpeningBookQueries comparative query', compQueries, [
      'best iPhone 16 vs Galaxy S25',
      'iPhone 16 vs Galaxy S25 review',
      'best iPhone 16 vs Galaxy S25 reddit',
      'iPhone 16 vs Galaxy S25 site:reddit.com',
    ]);
  }

  // ── 4. runOpeningBook with injected fake search ───────────────────────────
  {
    // Order of queries, searched count, provider and recencySensitive args
    const calledQueries = [];
    const searchArgs = [];
    const fakeSearch = async (q, provider, env, recencySensitive) => {
      calledQueries.push(q);
      searchArgs.push({ q, provider, env, recencySensitive });
      return [
        { url: `https://example.com/${encodeURIComponent(q)}`, title: `${q} title`, content: `${q} content` },
      ];
    };

    const res = await runOpeningBook({
      query: 'best air purifier',
      topicalCategory: 'air purifiers',
      facets: {},
      env: { TEST: '1' },
      recencySensitive: true,
      maxSearches: 4,
      deps: { search: fakeSearch },
    });

    eq('searched count is 4', res.searched, 4);
    eq('queries list matches returned list', res.queries, [
      'best air purifiers',
      'air purifiers review',
      'best air purifiers reddit',
      'air purifiers site:reddit.com',
    ]);
    eq('search called in exact sequential order', calledQueries, [
      'best air purifiers',
      'air purifiers review',
      'best air purifiers reddit',
      'air purifiers site:reddit.com',
    ]);
    eq('provider passed is web', searchArgs.every((a) => a.provider === 'web'), true);
    eq('recencySensitive forwarded', searchArgs.every((a) => a.recencySensitive === true), true);
    eq('sources collected length 4', res.sources.length, 4);

    // maxSearches slicing: maxSearches: 2 -> 2 queries
    calledQueries.length = 0;
    const resSlice = await runOpeningBook({
      query: 'best air purifier',
      topicalCategory: 'air purifiers',
      maxSearches: 2,
      deps: { search: fakeSearch },
    });
    eq('maxSearches 2 runs exactly 2 searches', resSlice.searched, 2);
    eq('maxSearches 2 returned queries length 2', resSlice.queries.length, 2);
    eq('maxSearches 2 called queries length 2', calledQueries.length, 2);
    eq('maxSearches 2 queries are first 2', resSlice.queries, [
      'best air purifiers',
      'air purifiers review',
    ]);

    // URL deduplication within batch
    const dupSearch = async (q) => {
      return [
        { url: 'https://example.com/shared', title: 'Shared' },
        { url: `https://example.com/${encodeURIComponent(q)}`, title: q },
        { url: 'https://example.com/shared', title: 'Shared Duplicate in Same Search' },
      ];
    };
    const resDup = await runOpeningBook({
      query: 'air purifiers',
      maxSearches: 4,
      deps: { search: dupSearch },
    });
    eq('sources deduped by url across searches and within searches', resDup.sources.length, 5);

    // CP-710: the same page from two providers (www, http, trailing slash) merges.
    const variantSearch = async (q) => (q.includes('reddit')
      ? [{ url: 'http://www.example.com/page/', title: 'Variant' }]
      : [{ url: 'https://example.com/page', title: 'Plain' }]);
    const resVariant = await runOpeningBook({ query: 'air purifiers', maxSearches: 4, deps: { search: variantSearch } });
    eq('url variants of one page merge to one source', resVariant.sources.map((s) => s.url), ['https://example.com/page']);
    eq('sources first url is shared', resDup.sources[0].url, 'https://example.com/shared');

    // Throwing search does not abort the rest
    let searchAttempt = 0;
    const flakySearch = async (q) => {
      searchAttempt++;
      if (searchAttempt === 2) {
        throw new Error('Search provider error');
      }
      return [{ url: `https://example.com/${searchAttempt}`, title: q }];
    };
    const resFlaky = await runOpeningBook({
      query: 'air purifiers',
      maxSearches: 4,
      deps: { search: flakySearch },
    });
    eq('throwing search does not abort and searched is 4', resFlaky.searched, 4);
    eq('sources collected from non-throwing searches is 3', resFlaky.sources.length, 3);

    // Zeroed result for maxSearches: 0
    let searchCalledOnZero = false;
    const zeroSearch = async () => { searchCalledOnZero = true; return []; };
    const resZero = await runOpeningBook({
      query: 'air purifiers',
      maxSearches: 0,
      deps: { search: zeroSearch },
    });
    eq('maxSearches: 0 returns zeroed object', resZero, { queries: [], searched: 0, sources: [] });
    ok('search was not called for maxSearches: 0', !searchCalledOnZero);

    // Zeroed result for negative maxSearches
    const resNeg = await runOpeningBook({
      query: 'air purifiers',
      maxSearches: -1,
      deps: { search: zeroSearch },
    });
    eq('maxSearches: -1 returns zeroed object', resNeg, { queries: [], searched: 0, sources: [] });

    // Zeroed result for empty subject
    let searchCalledOnEmpty = false;
    const emptySearch = async () => { searchCalledOnEmpty = true; return []; };
    const resEmpty = await runOpeningBook({
      query: '   ',
      topicalCategory: '',
      maxSearches: 4,
      deps: { search: emptySearch },
    });
    eq('empty subject returns zeroed object', resEmpty, { queries: [], searched: 0, sources: [] });
    ok('search was not called for empty subject', !searchCalledOnEmpty);
  }

  return report;
}
