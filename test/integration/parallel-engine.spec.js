// Coverage for worker/engine/parallel-engine.js — the production burst engine.
// We mock its two I/O dependencies (llm.js LLM calls, tools.js search/read) so
// the engine's own orchestration (decompose → search → dedup → read → notes →
// synth → validate, plus the FOSS injection + zero-source + stream-fallback
// paths) is exercised deterministically.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  callLLMStreaming: vi.fn(),
  runSearch: vi.fn(),
  readPageInto: vi.fn(),
}));

vi.mock('../../worker/engine/llm.js', () => ({
  callLLM: mocks.callLLM,
  callLLMStreaming: mocks.callLLMStreaming,
}));
vi.mock('../../worker/engine/tools.js', () => ({
  runSearch: mocks.runSearch,
  readPageInto: mocks.readPageInto,
}));

const { runParallelEngine } = await import('../../worker/engine/parallel-engine.js');
const { ENGINE_CONFIG } = await import('../../worker/lib/engine-config.js');

const CONFIG = ENGINE_CONFIG;

// A valid synthesis report (3 products clears validate's quality gate + min-3).
const REPORT = {
  summary: 'A roundup of home NAS options.', category: 'NAS',
  products: [
    { name: 'Synology DS224+', brand: 'Synology', rating: 4.6, pros: ['fast', 'quiet', 'easy'], cons: ['pricey', '2-bay'], verdict: 'Excellent home NAS overall, easy setup.', rank: 1 },
    { name: 'QNAP TS-233', brand: 'QNAP', rating: 4.1, pros: ['cheap', 'arm', 'apps'], cons: ['slow ui', 'plastic'], verdict: 'Solid budget pick for light home use.', rank: 2 },
    { name: 'TerraMaster F2-423', brand: 'TerraMaster', rating: 3.9, pros: ['10gbe', 'value', 'fast'], cons: ['software', 'support'], verdict: 'Great specs for the money if you tinker.', rank: 3 },
  ],
};

function sources(n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://rtings.com/nas-${i}`, title: `NAS Review ${i}`, source: 'web', credibility: { score: 80, tags: ['expert-domain'] },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  // callLLM routes by system prompt: decompose → aspects; notes → notes;
  // anything else (synth retry) → the report.
  mocks.callLLM.mockImplementation(async (key, model, messages) => {
    // Synth (retry path) uses the synth model; decompose + notes use the planner.
    if (model === CONFIG.synthModel) {
      return { choices: [{ message: { content: JSON.stringify(REPORT) } }], usage: { cost: 0.01 } };
    }
    const sys = messages?.[0]?.content || '';
    if (sys.includes('research aspects') || sys.includes('"aspects"')) {
      return { choices: [{ message: { content: JSON.stringify({ aspects: [{ title: 'Top picks', queries: ['best nas', 'nas review'] }] }) } }], usage: { cost: 0.001 } };
    }
    return { choices: [{ message: { content: JSON.stringify({ notes: [{ category: 'top', content: 'Synology DS224+ is widely praised for reliability and ease of use.' }] }) } }], usage: { cost: 0.001 } };
  });
  // Streaming synth: invoke the onToken callback (exercises announceProduct) then return.
  mocks.callLLMStreaming.mockImplementation(async (key, model, messages, onToken) => {
    const content = JSON.stringify(REPORT);
    if (onToken) onToken('', content);
    return { content, usage: { cost: 0.02 } };
  });
  mocks.runSearch.mockImplementation(async () => sources());
  mocks.readPageInto.mockImplementation(async (s) => { s.content = 'Full hands-on review text. '.repeat(40); });
});

describe('runParallelEngine', () => {
  it('runs the full pipeline and returns a validated report', async () => {
    const events = [];
    const res = await runParallelEngine('best home nas', CONFIG, 'key', {}, (t, m) => events.push(m), { recency_sensitive: false, is_buyable: true }, 'NAS', {});
    expect(res.result.products.length).toBe(3);
    expect(res.result.products[0].name).toBe('Synology DS224+');
    expect(res.sources.length).toBeGreaterThan(0);
    expect(res.synthModel).toBe(CONFIG.synthModel);
    expect(res.totalCostUsd).toBeGreaterThan(0);
    expect(events.some((m) => m.includes('Report complete'))).toBe(true);
  });

  it('gives the planner the classifier facets, like engine.js (CP-819)', async () => {
    const plannerUser = () => {
      const call = mocks.callLLM.mock.calls.find(([, , msgs]) => (msgs?.[0]?.content || '').includes('research aspects'));
      return call?.[2]?.[1]?.content || '';
    };
    await runParallelEngine('plumber near austin', CONFIG, 'key', {}, () => {}, { recency_sensitive: false, is_buyable: false, needs_location: true, is_service: true }, 'Plumbing', {});
    expect(plannerUser()).toContain('LOCATION-AWARE focus');
    expect(plannerUser()).toContain('SERVICE/PROFESSIONAL focus');
    expect(plannerUser()).not.toContain('BUYABLE PRODUCT focus');

    mocks.callLLM.mockClear();
    await runParallelEngine('best home nas', CONFIG, 'key', {}, () => {}, null, 'NAS', {});
    expect(plannerUser()).toContain('Query: "best home nas"');
    expect(plannerUser()).not.toContain('focus:');
  });

  it('merges url variants of one page from different providers (CP-710)', async () => {
    let call = 0;
    mocks.runSearch.mockImplementation(async () => {
      call++;
      const url = call % 2 ? 'https://rtings.com/nas' : 'http://www.rtings.com/nas/';
      return [{ url, title: 'NAS Review', source: 'web', credibility: { score: 80, tags: ['expert-domain'] } }];
    });
    const res = await runParallelEngine('best home nas', CONFIG, 'key', {}, () => {}, { recency_sensitive: false }, 'NAS', {});
    expect(call).toBeGreaterThan(1);
    expect(res.sources.map((s) => s.url)).toEqual(['https://rtings.com/nas']);
  });

  it('zero sources → honest non-result (empty products, no synth call)', async () => {
    mocks.runSearch.mockImplementation(async () => []);
    const res = await runParallelEngine('obscure query xyz', CONFIG, 'key', {}, () => {}, { recency_sensitive: true }, 'Misc', {});
    expect(res.result.products).toEqual([]);
    expect(mocks.callLLMStreaming).not.toHaveBeenCalled();
  });

  it('injects a by-name FOSS aspect for a self-hostable category', async () => {
    // 'photo backup' matches the foss-leaders allowlist → an extra aspect is
    // appended, so more search tasks are dispatched than the decompose alone.
    await runParallelEngine('best photo backup software', CONFIG, 'key', {}, () => {}, { recency_sensitive: false }, 'Backup', {});
    const queries = mocks.runSearch.mock.calls.map((c) => c[0]);
    expect(queries.some((q) => /immich/i.test(q))).toBe(true);
  });

  it('falls back to non-streaming synth when the stream throws', async () => {
    mocks.callLLMStreaming.mockImplementation(async () => { throw new Error('stream died'); });
    const res = await runParallelEngine('best home nas', CONFIG, 'key', {}, () => {}, { recency_sensitive: false }, 'NAS', {});
    expect(res.result.products.length).toBe(3); // recovered via callLLM retry
  });
});
