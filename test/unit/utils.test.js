// Full-coverage assertions for the pure helpers in utils.js.
import {
  slugify, generateSlug, isValidHttpsUrl, sanitizeUrl, escapeLikeWildcards,
  escapeHtml, escapeXml, displayQuery, isNotModified, timeAgo, parseJsonSafe,
  publicResearchFilter, canonicalizeQuery, singularizeToken, squashQuery,
  safeUserFacingError, monthKey, toPersistedSources, SOURCE_SNIPPET_CHARS,
} from '../../worker/lib/utils.js';

export function runUtilsTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // slugify
  eq('slugify basic', slugify('Best NAS for Home!'), 'best-nas-for-home');
  eq('slugify trims dashes', slugify('  --Hello--  '), 'hello');
  eq('slugify empty → research', slugify('!!!'), 'research');
  eq('slugify caps length', slugify('a'.repeat(200)).length, 80);

  // generateSlug
  eq('generateSlug', generateSlug('best nas', 'abcd1234efgh'), 'best-nas-abcd1234');

  // isValidHttpsUrl / sanitizeUrl
  ok('https valid', isValidHttpsUrl('https://x.com/a'));
  ok('http invalid', !isValidHttpsUrl('http://x.com'));
  ok('garbage invalid', !isValidHttpsUrl('not a url'));
  eq('sanitizeUrl valid', sanitizeUrl('https://x.com'), 'https://x.com');
  eq('sanitizeUrl invalid', sanitizeUrl('http://x.com'), '');

  // escapeLikeWildcards
  eq('escapeLike', escapeLikeWildcards('50% off_now'), '50\\% off\\_now');

  // escapeHtml / escapeXml
  eq('escapeHtml', escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  eq('escapeHtml null → empty', escapeHtml(null), '');
  eq('escapeHtml undefined → empty', escapeHtml(undefined), '');
  eq('escapeHtml number → string', escapeHtml(5), '5');
  eq('escapeXml apos', escapeXml(`a'<&">`), 'a&apos;&lt;&amp;&quot;&gt;');

  // displayQuery: uppercase kept, digit upper, stopword mid lower, ends capitalized
  eq('displayQuery', displayQuery('best wifi router for the home'), 'Best Wifi Router for the Home');
  eq('displayQuery keeps caps + digits', displayQuery('iPhone 16 vs 4k'), 'iPhone 16 vs 4K');

  // isNotModified
  const now = Math.floor(Date.now() / 1000);
  ok('inm future', isNotModified(new Date((now + 50) * 1000).toUTCString(), now));
  ok('inm past false', !isNotModified(new Date((now - 50) * 1000).toUTCString(), now));
  ok('inm null false', !isNotModified(null, now));
  ok('inm bad date false', !isNotModified('garbage', now));

  // timeAgo (all four branches)
  eq('timeAgo now', timeAgo(Date.now() - 5_000), 'just now');
  eq('timeAgo minutes', timeAgo(Date.now() - 120_000), '2m ago');
  eq('timeAgo hours', timeAgo(Date.now() - 7_200_000), '2h ago');
  eq('timeAgo days', timeAgo(Date.now() - 2 * 86_400_000), '2d ago');

  // parseJsonSafe
  eq('json falsy → fallback', parseJsonSafe('', 'fb'), 'fb');
  eq('json valid', parseJsonSafe('{"a":1}', null), { a: 1 });
  eq('json invalid → fallback', parseJsonSafe('{bad', 'fb'), 'fb');

  // safeUserFacingError
  eq('safeUserFacingError clean passes through', safeUserFacingError('No reliable products found for this query.'), 'No reliable products found for this query.');
  eq('safeUserFacingError trims whitespace', safeUserFacingError('  Clean error message  '), 'Clean error message');
  eq('safeUserFacingError default fallback on empty', safeUserFacingError(''), 'Research failed');
  eq('safeUserFacingError custom fallback on empty', safeUserFacingError(null, 'Custom fallback'), 'Custom fallback');
  eq('safeUserFacingError custom fallback on undefined', safeUserFacingError(undefined, 'Custom fallback'), 'Custom fallback');
  eq('safeUserFacingError over-long replaced', safeUserFacingError('a'.repeat(161)), 'Research failed');
  eq('safeUserFacingError URL replaced', safeUserFacingError('Failed at https://api.openrouter.ai/v1'), 'Research failed');
  eq('safeUserFacingError http URL replaced', safeUserFacingError('Failed at http://example.com/err'), 'Research failed');
  eq('safeUserFacingError braces replaced', safeUserFacingError('{"error":"bad"}'), 'Research failed');
  eq('safeUserFacingError api key replaced', safeUserFacingError('Invalid API key provided'), 'Research failed');
  eq('safeUserFacingError 4xx status replaced', safeUserFacingError('Upstream returned 403 Forbidden'), 'Research failed');
  eq('safeUserFacingError 5xx status replaced', safeUserFacingError('Server returned 500 internal error'), 'Research failed');
  eq('safeUserFacingError openrouter token timeout replaced', safeUserFacingError('openrouter timeout token stack trace'), 'Research failed');
  eq('safeUserFacingError prompt injection replaced', safeUserFacingError('Detected prompt injection attempt'), 'Research failed');

  // publicResearchFilter (string builder; just verify alias substitution)
  ok('publicFilter uses alias', publicResearchFilter('r').includes("r.status = 'complete'"));
  ok('publicFilter thin-page gate', publicResearchFilter('research').includes('research_id = research.id'));

  // singularizeToken: table-driven tests for exceptions and plural rules
  const singularizeCases = [
    ['glass', 'glass'],
    ['lens', 'lens'],
    ['series', 'series'],
    ['chess', 'chess'],
    ['gps', 'gps'],
    ['nas', 'nas'],
    ['ups', 'ups'],
    ['class', 'class'],
    ['plus', 'plus'],
    ['batteries', 'battery'],
    ['boxes', 'box'],
    ['watches', 'watch'],
    ['dishes', 'dish'],
    ['glasses', 'glass'],
    ['keyboards', 'keyboard'],
    ['lenses', 'lens'],
  ];
  for (const [input, expected] of singularizeCases) {
    eq(`singularizeToken: ${input} -> ${expected}`, singularizeToken(input), expected);
  }

  // squashQuery: basic and empty cases
  eq('squashQuery light bulb', squashQuery('light bulb'), 'lightbulb');
  eq('squashQuery empty', squashQuery(''), '');

  // canonicalizeQuery: stopwords + filler stripped, singularized, sorted/unique
  eq('canonical strips stopwords+filler+sorts', canonicalizeQuery('Best Wireless Keyboard under $100 2026', {}), 'keyboard wireless');
  eq('canonical order-insensitive', canonicalizeQuery('budget keyboard best', {}), canonicalizeQuery('best keyboard budget', {}));
  eq('canonical no clarifications', canonicalizeQuery('mesh wifi system', null), 'mesh system wifi');
  eq('canonical with clarifications', canonicalizeQuery('mesh wifi', { budget: '$200' }), 'mesh wifi budget:$200');
  // clarification value that slugifies to empty still yields base + key:
  eq('canonical clarification empty value', canonicalizeQuery('mesh wifi', { x: '!!!' }), 'mesh wifi x:');

  // canonicalizeQuery + squashQuery: compound-word and plural clustering
  const canonicalClusterCases = [
    ['lightbulb', 'lightbulb'],
    ['lightbulbs', 'lightbulb'],
    ['light bulb', 'bulb light'],
    ['best light bulbs', 'bulb light'],
  ];
  for (const [input, expected] of canonicalClusterCases) {
    eq(`canonicalizeQuery: ${input} -> ${expected}`, canonicalizeQuery(input), expected);
  }

  // Two queries collide when canonicalizeQuery matches OR squashQuery matches
  const queriesCollide = (q1, q2) => {
    return canonicalizeQuery(q1) === canonicalizeQuery(q2) ||
           squashQuery(q1) === squashQuery(q2);
  };

  const trio = ['lightbulb', 'lightbulbs', 'light bulb'];
  for (let i = 0; i < trio.length; i++) {
    for (let j = i + 1; j < trio.length; j++) {
      ok(`collision pair: "${trio[i]}" vs "${trio[j]}"`, queriesCollide(trio[i], trio[j]));
    }
  }

  // monthKey (CP-358: moved here from pipeline/orchestrator.js)
  eq('monthKey pads month', monthKey(new Date(Date.UTC(2026, 0, 31, 23, 59))), '2026-01');
  eq('monthKey december', monthKey(new Date(Date.UTC(2026, 11, 1))), '2026-12');
  ok('monthKey default is now', /^\d{4}-\d{2}$/.test(monthKey()));

  // toPersistedSources (CP-408): keep a short text snippet per source so live
  // reports can be audited against what the engine actually read.
  eq('snippet cap is 200', SOURCE_SNIPPET_CHARS, 200);
  const long = 'word '.repeat(100);
  const persisted = toPersistedSources([
    { url: 'https://a.com', credibility: 80, title: 'A', content: long },
    { url: 'https://b.com', credibility: 40, content: '  line one\n\n  line two  ' },
    { url: 'https://c.com', credibility: 10 },
    { url: 'https://d.com', credibility: 5, content: '   ' },
  ]);
  eq('snippet capped', persisted[0].snippet.length, 200);
  eq('snippet keeps url + credibility', [persisted[0].url, persisted[0].credibility], ['https://a.com', 80]);
  eq('snippet collapses whitespace', persisted[1].snippet, 'line one line two');
  eq('no content → no snippet key', persisted[2], { url: 'https://c.com', credibility: 10 });
  eq('blank content → no snippet key', persisted[3], { url: 'https://d.com', credibility: 5 });
  eq('non-array → empty', toPersistedSources(null), []);
  const emoji = toPersistedSources([{ url: 'https://g.com', credibility: 1, content: 'a'.repeat(199) + '😀😀' }]);
  eq('snippet does not split an emoji', emoji[0].snippet, 'a'.repeat(199) + '😀');
  eq('skips non-objects', toPersistedSources([null, 'x', { url: 'https://e.com', credibility: 1 }]), [{ url: 'https://e.com', credibility: 1 }]);
  const input = [{ url: 'https://f.com', credibility: 1, content: 'abc' }];
  toPersistedSources(input);
  eq('input not mutated', input, [{ url: 'https://f.com', credibility: 1, content: 'abc' }]);

  return report;
}
