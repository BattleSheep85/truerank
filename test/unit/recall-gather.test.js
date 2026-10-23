// Unit tests for the recall gather module.
import {
  nameEvidenced,
  unevidencedProposals,
  recallQueriesFor,
  runRecallGather,
} from '../../worker/engine/recall-gather.js';

export async function runRecallGatherTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // ── nameEvidenced ──────────────────────────────────────────────────────────
  {
    const sources = [
      { title: 'Top Photo Apps of 2026', content: 'We tested Immich and found it great.' },
      { title: 'PhotoPrism Review', content: 'Self-hosted photo management.' },
    ];
    ok('match in title', nameEvidenced('PhotoPrism', sources));
    ok('match in content', nameEvidenced('Immich', sources));
    ok('case-insensitive match in title', nameEvidenced('photoprism', sources));
    ok('case-insensitive match in content', nameEvidenced('iMMiCh', sources));
    // word boundary checks (prevent substring false positives like "Arc" in "March")
    const marchSources = [{ title: 'Top Photo Apps of March 2026', content: 'Updated in March for spring.' }];
    ok('"Arc" inside "March" does NOT match', !nameEvidenced('Arc', marchSources));
    const arcSources = [{ title: 'Top Photo Apps with Arc Browser', content: 'Arc is a great browser.' }];
    ok('"Arc" as standalone word DOES match', nameEvidenced('Arc', arcSources));

    // multi-word phrase boundary checks
    const multiSources = [{ title: 'Sony Review', content: 'We compared Beta Max and VHS.' }];
    ok('multi-word phrase "Beta Max" matches', nameEvidenced('Beta Max', multiSources));
    const subPhraseSources = [{ title: 'Sony Review', content: 'Beta Maximum throughput tested.' }];
    ok('multi-word phrase "Beta Max" does NOT match "Beta Maximum"', !nameEvidenced('Beta Max', subPhraseSources));

    // null-safety and edge cases
    ok('null name returns false', !nameEvidenced(null, sources));
    ok('undefined name returns false', !nameEvidenced(undefined, sources));
    ok('empty name returns false', !nameEvidenced('', sources));
    ok('null sources returns false', !nameEvidenced('Immich', null));
    ok('undefined sources returns false', !nameEvidenced('Immich', undefined));
    ok('empty sources returns false', !nameEvidenced('Immich', []));
    ok('null elements inside sources', !nameEvidenced('Immich', [null, { title: null, content: null }]));
  }

  // ── unevidencedProposals ───────────────────────────────────────────────────
  {
    const sources = [{ title: 'Beta Max review', content: 'Testing Beta Max' }];
    const proposals = [
      '  Alpha Pro  ',
      'alpha pro',
      'AB',
      'Beta Max',
      'Gamma Ray',
      'Delta Force',
      'Epsilon',
    ];
    const limited = unevidencedProposals(proposals, sources, 2);
    eq('unevidencedProposals filters evidenced, dedupes, drops <3 chars, honors limit', limited, [
      'Alpha Pro',
      'Gamma Ray',
    ]);

    const all = unevidencedProposals(proposals, sources, 4);
    eq('unevidencedProposals honors limit 4 and preserves order', all, [
      'Alpha Pro',
      'Gamma Ray',
      'Delta Force',
      'Epsilon',
    ]);

    eq('null proposals returns empty array', unevidencedProposals(null, sources), []);
    eq('limit 0 returns empty array', unevidencedProposals(proposals, sources, 0), []);
  }

  // ── recallQueriesFor ───────────────────────────────────────────────────────
  {
    eq('recallQueriesFor basic', recallQueriesFor('Immich'), ['Immich review', 'Immich reddit']);
    eq('recallQueriesFor trimmed', recallQueriesFor('  PhotoPrism  '), ['PhotoPrism review', 'PhotoPrism reddit']);
  }

  // ── runRecallGather: happy path ────────────────────────────────────────────
  {
    let proposeCalls = 0;
    const searchCalls = [];
    const fakePropose = async (query, category, existing, sources, key, model) => {
      proposeCalls++;
      return ['Alpha One', 'Beta Two'];
    };
    const fakeSearch = async (q, provider, env, recencySensitive) => {
      searchCalls.push({ q, provider, recencySensitive });
      return [
        {
          url: `https://example.com/${encodeURIComponent(q)}`,
          title: `${q} page`,
          content: `${q} mentions Alpha One and Beta Two`,
        },
      ];
    };

    const initialSources = [{ url: 'https://example.com/main', title: 'Main', content: 'Intro overview' }];
    const res = await runRecallGather({
      query: 'best self hosted photos',
      topicalCategory: 'software',
      sources: initialSources,
      notes: [],
      openrouterKey: 'sk-test',
      recallModel: 'openai/gpt-4o-mini',
      env: {},
      recencySensitive: true,
      maxNames: 4,
      maxSearches: 8,
      deps: { propose: fakePropose, search: fakeSearch },
    });

    eq('propose called once', proposeCalls, 1);
    eq('searched count is 4', res.searched, 4);
    eq('proposed count is 2', res.proposed, 2);
    eq('recovered count is 2', res.recovered, 2);
    eq('collected sources length is 4', res.sources.length, 4);
    eq('search providers all web', searchCalls.every((c) => c.provider === 'web'), true);
  }

  // ── runRecallGather: maxSearches cap ───────────────────────────────────────
  {
    let searches = 0;
    const fakePropose = async () => ['Alpha One', 'Beta Two'];
    const fakeSearch = async (q) => {
      searches++;
      return [{ url: `https://example.com/${searches}`, title: q, content: q }];
    };

    const res = await runRecallGather({
      query: 'best tools',
      sources: [{ url: 'https://example.com/init', title: 'Init', content: 'Init' }],
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      maxSearches: 3,
      deps: { propose: fakePropose, search: fakeSearch },
    });

    eq('maxSearches cap strictly respected', res.searched, 3);
    eq('searches performed exactly 3', searches, 3);
    eq('sources collected length 3', res.sources.length, 3);
  }

  // ── runRecallGather: throwing search does not abort the rest ───────────────
  {
    let count = 0;
    const fakePropose = async () => ['Alpha One', 'Beta Two'];
    const fakeSearch = async (q) => {
      count++;
      if (count === 2) throw new Error('Search provider network glitch');
      return [{ url: `https://example.com/${count}`, title: q, content: q }];
    };

    const res = await runRecallGather({
      query: 'best tools',
      sources: [{ url: 'https://example.com/init', title: 'Init', content: 'Init' }],
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      maxSearches: 4,
      deps: { propose: fakePropose, search: fakeSearch },
    });

    eq('searched count increments even on failure', res.searched, 4);
    eq('sources collected ignores failed search', res.sources.length, 3);
  }

  // ── runRecallGather: url variants of a known page are not appended (CP-710) ──
  {
    const res = await runRecallGather({
      query: 'best tools',
      sources: [{ url: 'https://www.example.com/known/', title: 'Init', content: 'Init' }],
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      maxSearches: 2,
      deps: { propose: async () => ['Alpha One'], search: async () => [{ url: 'http://example.com/known', title: 'Alpha One', content: 'x' }] },
    });
    eq('url variant of a known page is not a new source', res.sources.length, 0);
  }

  // ── runRecallGather: proposals already evidenced produce searched === 0 ────
  {
    let searchCalled = false;
    const fakePropose = async () => ['Alpha One', 'Beta Two'];
    const fakeSearch = async () => {
      searchCalled = true;
      return [];
    };

    const incomingSources = [
      { url: 'https://example.com/1', title: 'Alpha One Review', content: 'Content' },
      { url: 'https://example.com/2', title: 'Overview', content: 'Mentions Beta Two here' },
    ];

    const res = await runRecallGather({
      query: 'best tools',
      sources: incomingSources,
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      deps: { propose: fakePropose, search: fakeSearch },
    });

    eq('proposed count recorded', res.proposed, 2);
    eq('zero searches performed when all evidenced', res.searched, 0);
    eq('zero recovered', res.recovered, 0);
    eq('zero new sources', res.sources.length, 0);
    ok('search was never called', !searchCalled);
  }

  // ── runRecallGather: url deduplication against incoming and within batch ───
  {
    const fakePropose = async () => ['Alpha One'];
    const fakeSearch = async (q) => {
      return [
        { url: 'https://example.com/existing', title: 'Dup of incoming' },
        { url: 'https://example.com/new1', title: 'First instance' },
        { url: 'https://example.com/new1', title: 'Duplicate in batch' },
        { url: 'https://example.com/new2', title: 'Second unique' },
      ];
    };

    const incomingSources = [
      { url: 'https://example.com/existing', title: 'Existing', content: 'None' },
    ];

    const res = await runRecallGather({
      query: 'best tools',
      sources: incomingSources,
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      deps: { propose: fakePropose, search: fakeSearch },
    });

    eq('deduplicated sources length', res.sources.length, 2);
    eq('deduplicated URLs list', res.sources.map((s) => s.url), [
      'https://example.com/new1',
      'https://example.com/new2',
    ]);
  }

  // ── runRecallGather: missing keys or params -> zeroed result ───────────────
  {
    let proposeCalled = false;
    const fakePropose = async () => {
      proposeCalled = true;
      return ['Alpha One'];
    };

    const baseOpts = {
      query: 'best tools',
      sources: [{ url: 'https://example.com/1', title: 'Init', content: 'Init' }],
      openrouterKey: 'sk-test',
      recallModel: 'test-model',
      maxSearches: 4,
      deps: { propose: fakePropose },
    };

    const r1 = await runRecallGather({ ...baseOpts, openrouterKey: '' });
    eq('missing openrouterKey -> zeroed', r1, { proposed: 0, searched: 0, recovered: 0, sources: [] });

    const r2 = await runRecallGather({ ...baseOpts, recallModel: '' });
    eq('missing recallModel -> zeroed', r2, { proposed: 0, searched: 0, recovered: 0, sources: [] });

    const r3 = await runRecallGather({ ...baseOpts, maxSearches: 0 });
    eq('maxSearches < 1 -> zeroed', r3, { proposed: 0, searched: 0, recovered: 0, sources: [] });

    const r4 = await runRecallGather({ ...baseOpts, sources: [] });
    eq('empty sources -> zeroed', r4, { proposed: 0, searched: 0, recovered: 0, sources: [] });

    const r5 = await runRecallGather({ ...baseOpts, sources: null });
    eq('null sources -> zeroed', r5, { proposed: 0, searched: 0, recovered: 0, sources: [] });

    ok('propose never called when input invalid', !proposeCalled);
  }

  return report;
}
