// Refocus 2026-10, plan piece 4 (spec D2, R4): a row with retired_at set
// appears on no public surface. Listings, the cluster winner, the sitemap, the
// feed, autocomplete, the homepage recent list, the 14-day cluster cache, and
// the verify "better alternatives" lookup all skip it.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { insertProductV2 } from './_helpers.js';
import { listableCountSql, listableRowsSql } from '../../worker/lib/listable.js';
import {
  getClusterWinnerSlug, findResearchByCanonicalQuery, findRankingForCategory,
} from '../../worker/lib/db.js';
import { recentReportsSection } from '../../worker/pages/home.js';

const BASE = 'https://chrisputer.tech';
const NOW = Math.floor(Date.now() / 1000);

const CLUSTER = 'widget cluster';
const LIVE = { id: 'id-live', slug: 'best-widget-live-report', query: 'best widget live report', canonical: CLUSTER, created_at: NOW - 3600, retired: false };
// Newer member of the same cluster: without the retired filter it would win.
const RETIRED_MEMBER = { id: 'id-retired-member', slug: 'best-widget-retired-report', query: 'best widget retired report', canonical: CLUSTER, created_at: NOW - 60, retired: true };
const RETIRED_OTHER = { id: 'id-retired-other', slug: 'best-widget-gadget-retired', query: 'best widget gadget retired', canonical: 'gadget cluster', created_at: NOW - 120, retired: true, category: 'Gadgets' };
const RETIRED_SLUGS = [RETIRED_MEMBER.slug, RETIRED_OTHER.slug];

async function seedRow(db, row) {
  await db.prepare(
    `INSERT INTO research (id, slug, query, status, canonical_query, created_at, completed_at, summary, category, retired_at, retired_reason)
     VALUES (?1, ?2, ?3, 'complete', ?4, ?5, ?5, 'A summary.', ?6, ?7, ?8)`,
  ).bind(
    row.id, row.slug, row.query, row.canonical, row.created_at, row.category ?? 'Widgets',
    row.retired ? row.created_at + 1 : null, row.retired ? 'seo-flywheel' : null,
  ).run();
  for (let p = 1; p <= 3; p++) {
    await insertProductV2(db, { researchId: row.id, name: `${row.slug} product ${p}`, rank: p, rating: 4 });
  }
}

function expectNoRetiredSlug(text) {
  for (const slug of RETIRED_SLUGS) expect(text).not.toContain(slug);
}

beforeAll(async () => {
  await applySchema(env.DB);
  for (const row of [LIVE, RETIRED_MEMBER, RETIRED_OTHER]) await seedRow(env.DB, row);
});

describe('listable set', () => {
  it('listableRowsSql excludes retired rows, and the older live member wins its cluster', async () => {
    const rows = (await env.DB.prepare(listableRowsSql({ select: 'slug' })).all()).results ?? [];
    const slugs = rows.map((r) => r.slug);
    expect(slugs).toEqual([LIVE.slug]);
  });

  it('listableCountSql counts live clusters only', async () => {
    const row = await env.DB.prepare(listableCountSql()).first();
    expect(row.n).toBe(1);
  });

  it('getClusterWinnerSlug returns the live member', async () => {
    expect(await getClusterWinnerSlug(env.DB, CLUSTER)).toBe(LIVE.slug);
  });
});

describe('public surfaces', () => {
  it('GET /sitemap.xml lists no retired slug', async () => {
    const res = await SELF.fetch(`${BASE}/sitemap.xml`);
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`/research/${LIVE.slug}`);
    expectNoRetiredSlug(xml);
  });

  it('GET /feed.xml lists no retired slug', async () => {
    const res = await SELF.fetch(`${BASE}/feed.xml`);
    expect(res.status).toBe(200);
    expectNoRetiredSlug(await res.text());
  });

  it('GET /api/search/suggest suggests no retired slug', async () => {
    const res = await SELF.fetch(`${BASE}/api/search/suggest?q=widget`);
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.map((r) => r.slug)).toEqual([LIVE.slug]);
  });

  it('GET /research lists no retired slug', async () => {
    const res = await SELF.fetch(`${BASE}/research`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`/research/${LIVE.slug}`);
    expectNoRetiredSlug(html);
  });

  it('recentReportsSection shows no retired slug', async () => {
    const html = await recentReportsSection(env);
    expect(html).toContain(`/research/${LIVE.slug}`);
    expectNoRetiredSlug(html);
  });
});

describe('cluster cache and verify alternatives', () => {
  it('findResearchByCanonicalQuery returns the live row, not the newer retired one', async () => {
    const row = await findResearchByCanonicalQuery(env.DB, CLUSTER);
    expect(row?.slug).toBe(LIVE.slug);
  });

  it('findResearchByCanonicalQuery returns null when only a retired row matches', async () => {
    expect(await findResearchByCanonicalQuery(env.DB, RETIRED_OTHER.canonical)).toBeNull();
  });

  it('findRankingForCategory skips the retired row', async () => {
    const found = await findRankingForCategory(env.DB, 'widgets');
    expect(found?.research?.slug).toBe(LIVE.slug);
    expect(await findRankingForCategory(env.DB, 'gadgets')).toBeNull();
  });
});
