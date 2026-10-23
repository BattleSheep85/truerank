// CP-803: two input/output boundaries, end to end on real D1 via Miniflare.
//   1. A local or experience page ("coffee shops in Brooklyn") renders no Amazon button,
//      while a product page still does. The classifier marks these rows is_experience +
//      needs_location, not is_service, and old rows carry no sold_on_amazon facet.
//   2. POST /api/research rejects SQL-injection probes before any row exists, and lets
//      the normal searches the screen used to block through to the queue.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { insertProductV2 } from './_helpers.js';
import { handleStartResearch } from '../../worker/handlers/research.js';

const BASE = 'https://chrisputer.tech';
const NOW = Math.floor(Date.now() / 1000);

const COFFEE = {
  id: 'cp803-coffee', slug: 'best-coffee-shops-in-brooklyn-cp803', query: 'best coffee shops in brooklyn',
  category: 'coffee shops in Brooklyn',
  facets: { needs_location: true, is_buyable: false, is_experience: true, is_content: false, is_service: false, is_comparative: false },
  names: ['SEY Coffee', 'Devocion', 'Partners Coffee'],
};
const KETTLE = {
  id: 'cp803-kettle', slug: 'best-electric-kettle-cp803', query: 'best electric kettle',
  category: 'electric kettles',
  facets: { needs_location: false, is_buyable: true, is_experience: false, is_service: false, sold_on_amazon: true },
  names: ['Fellow Stagg EKG', 'Cosori Gooseneck', 'Bonavita Variable'],
};

async function seed(db, row) {
  await db.prepare(
    `INSERT INTO research (id, slug, query, status, canonical_query, created_at, completed_at, summary, category, facets)
     VALUES (?1, ?2, ?3, 'complete', ?3, ?4, ?4, 'A summary.', ?5, ?6)`,
  ).bind(row.id, row.slug, row.query, NOW - 60, row.category, JSON.stringify(row.facets)).run();
  for (const [i, name] of row.names.entries()) {
    await insertProductV2(db, { researchId: row.id, name, rank: i + 1, rating: 4.5 });
  }
}

const post = (query) => new Request(`${BASE}/api/research`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.203' },
  body: JSON.stringify({ query }),
});
// Same queue stub as research.spec.js: a real send would run the paid pipeline.
const testEnv = { ...env, RESEARCH_QUEUE: { send: async () => {} } };

beforeAll(async () => {
  await applySchema(env.DB);
  await seed(env.DB, COFFEE);
  await seed(env.DB, KETTLE);
});

describe('Amazon buttons by page kind', () => {
  it('a coffee-shop page has no Amazon button and hands off to Google', async () => {
    const res = await SELF.fetch(`${BASE}/research/${COFFEE.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SEY Coffee');
    expect(html).not.toContain('Search Amazon');
    expect(html).not.toContain('Buy on Amazon');
    expect(html).toContain('Find on Google');
  });

  it('a product page still shows its Amazon button', async () => {
    const res = await SELF.fetch(`${BASE}/research/${KETTLE.slug}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Search Amazon');
  });
});

describe('POST /api/research input boundary', () => {
  it('rejects the SQL probe that became a public page, and creates no row', async () => {
    const probe = "best tax software for self employed) and extractvalue(6920,concat(0x5c,0x71706a7171,(select (elt(6920=6920,1))),0x7162706271))-- shca";
    const res = await handleStartResearch(post(probe), testEnv);
    expect(res.status).toBe(422);
    expect((await res.json()).reason).toBe('probe');
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM research WHERE query LIKE '%extractvalue%'").first();
    expect(row.n).toBe(0);
  });

  it('rejects a boolean tautology probe', async () => {
    const res = await handleStartResearch(post("best tv' or 1=1--"), testEnv);
    expect(res.status).toBe(422);
  });

  for (const query of ['fentanyl test strips', 'canon r 6', 'buy a tv']) {
    it(`lets "${query}" past the safety screen`, async () => {
      const res = await handleStartResearch(post(query), testEnv);
      expect(res.status).not.toBe(422);
    });
  }
});
