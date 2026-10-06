// Refocus 2026-10, plan piece 6 (spec D4, R5): the dynamic /best/:slug hubs
// answer 404. The 4 static guides still answer 200. The sitemap lists no hub
// URL, and /research shows no "Browse by category" strip.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { completeResearch, insertProductV2 } from './_helpers.js';
import { STATIC_GUIDES } from '../../worker/lib/guides.js';

const BASE = 'https://chrisputer.tech';

async function seedNasReport(db, slug, query, canonicalQuery) {
  const id = generateId();
  await insertResearch(db, { id, slug, query, canonicalQuery });
  await completeResearch(db, {
    id, status: 'complete', summary: 'NAS roundup.', category: 'NAS',
    result: JSON.stringify({ source_count: 4 }), sources: '[]',
  });
  for (let i = 1; i <= 3; i++) {
    await insertProductV2(db, { researchId: id, name: `${slug} NAS ${i}`, rank: i, rating: 4.3 });
  }
}

beforeAll(async () => {
  await applySchema(env.DB);
  // 2 public rows in distinct clusters: enough for a hub before this change.
  await seedNasReport(env.DB, 'best-budget-nas-hub', 'best budget nas hub', 'budget nas hub');
  await seedNasReport(env.DB, 'best-home-nas-hub', 'best home nas hub', 'home nas hub');
});

describe('/best/ hubs retired', () => {
  it('GET /best/nas answers 404', async () => {
    const res = await SELF.fetch(`${BASE}/best/nas`, { headers: { Accept: 'text/html' } });
    expect(res.status).toBe(404);
  });

  it('GET /best/mechanical-keyboards-under-100/ still serves the static guide (200)', async () => {
    const res = await SELF.fetch(`${BASE}/best/mechanical-keyboards-under-100/`);
    expect(res.status).toBe(200);
  });

  it('/sitemap.xml lists the 4 static guides and no other /best/<slug> URL', async () => {
    const res = await SELF.fetch(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    const bestSlugs = [...xml.matchAll(/<loc>https:\/\/chrisputer\.tech\/best\/([a-z0-9-]+)\/?<\/loc>/g)].map((m) => m[1]);
    const guideSlugs = STATIC_GUIDES.map((g) => g.slug);
    expect(guideSlugs).toHaveLength(4);
    expect([...bestSlugs].sort()).toEqual([...guideSlugs].sort());
  });

  it('GET /research shows no "Browse by category" strip', async () => {
    const res = await SELF.fetch(`${BASE}/research`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('Browse by category');
    expect(html).not.toContain('href="/best/nas"');
  });
});
