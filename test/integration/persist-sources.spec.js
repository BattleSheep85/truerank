// CP-408: persistEngineResult used to save only {url, credibility} per source,
// so a live report could not be audited against the pages the engine read.
// It now keeps a short snippet of each source's text in research.sources.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { persistEngineResult } from '../../worker/pipeline/orchestrator.js';
import { generateId, insertResearch, updateResearchStatus } from '../../worker/lib/db.js';
import { SOURCE_SNIPPET_CHARS } from '../../worker/lib/utils.js';

beforeAll(async () => {
  await applySchema(env.DB);
});

async function seedProcessingRow() {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: 's-' + id, query: 'best widget', canonicalQuery: null });
  await updateResearchStatus(env.DB, id, 'processing');
  return id;
}

// No search keys and a product that already has an image, so persist makes no
// network call (ASIN lookup is skipped by sold_on_amazon: false).
const offlineEnv = () => ({ ...env, SEARXNG_URL: '', SERPER_API_KEY: '', BRAVE_API_KEY: '' });

const ENGINE = {
  result: {
    summary: 'One widget wins.',
    category: 'widgets',
    products: [{ name: 'Widget One', rank: 1, imageUrl: 'https://img.example/w.jpg', pros: [], cons: [] }],
  },
  sources: [
    { url: 'https://rtings.com/w', credibility: 90, content: 'Measured battery 10.5 hours. '.repeat(20) },
    { url: 'https://reddit.com/r/w', credibility: 50 },
  ],
  totalCostUsd: 0,
  synthModel: 'test-model',
};

describe('persistEngineResult sources (CP-408)', () => {
  it('saves a capped text snippet per source next to url and credibility', async () => {
    const id = await seedProcessingRow();
    const res = await persistEngineResult(offlineEnv(), id, 'best widget', { sold_on_amazon: false }, 'widgets', ENGINE, null);
    expect(res.status).toBe('complete');

    const row = await env.DB.prepare('SELECT sources FROM research WHERE id = ?').bind(id).first();
    const saved = JSON.parse(row.sources);
    expect(saved).toHaveLength(2);
    expect(saved[0].url).toBe('https://rtings.com/w');
    expect(saved[0].credibility).toBe(90);
    expect(saved[0].snippet.startsWith('Measured battery 10.5 hours.')).toBe(true);
    expect(saved[0].snippet.length).toBe(SOURCE_SNIPPET_CHARS);
    expect(saved[1]).toEqual({ url: 'https://reddit.com/r/w', credibility: 50 });
  });
});
