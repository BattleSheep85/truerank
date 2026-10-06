// Integration coverage for worker/lib/db.js — every CRUD helper exercised
// against a real (in-memory Miniflare) D1, with the actual schema applied.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import init from '../../schema/001_initial.sql?raw';
import guides from '../../schema/002_guide_clicks.sql?raw';
import v2 from '../../schema/003_research_v2.sql?raw';
import keywords from '../../schema/006_keyword_queue.sql?raw';
import claims from '../../schema/010_claims.sql?raw';
import verification from '../../schema/011_verification.sql?raw';
import squashedQuery from '../../schema/014_squashed_query.sql?raw';
import processingStarted from '../../schema/015_processing_started.sql?raw';
import retireSeoRows from '../../schema/017_retire_seo_rows.sql?raw';
import * as db from '../../worker/lib/db.js';
import { completeResearch, insertProductV2 } from './_helpers.js';

// Apply a .sql file statement-by-statement (D1 has no multi-statement exec via
// prepare). Strips line comments; splits on ';'. Fine for our DDL (no ';' in
// string literals).
async function applySql(sql) {
  const stmts = sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) await env.DB.prepare(s).run();
}

beforeAll(async () => {
  await applySql(init);
  await applySql(guides);
  await applySql(v2);
  await applySql(keywords);
  await applySql(claims);
  await applySql(verification);
  await applySql(squashedQuery);
  await applySql(processingStarted);
  await applySql(retireSeoRows);
});

describe('db.js', () => {
  it('generateId → 16-char [a-z0-9]', () => {
    const id = db.generateId();
    expect(id).toMatch(/^[a-z0-9]{16}$/);
    expect(db.generateId()).not.toBe(id);
  });

  it('insertResearch + getResearchById + getResearchBySlug', async () => {
    const id = db.generateId();
    await db.insertResearch(env.DB, { id, slug: 'best-nas-x', query: 'best nas', canonicalQuery: 'nas', tier: 'full' });
    const byId = await db.getResearchById(env.DB, id);
    expect(byId.query).toBe('best nas');
    expect(byId.status).toBe('pending');
    const bySlug = await db.getResearchBySlug(env.DB, 'best-nas-x');
    expect(bySlug.id).toBe(id);
  });

  it('updateResearchStatus', async () => {
    const id = db.generateId();
    await db.insertResearch(env.DB, { id, slug: 's-' + id, query: 'q1', canonicalQuery: 'q1' });
    await db.updateResearchStatus(env.DB, id, 'processing');
    expect((await db.getResearchById(env.DB, id)).status).toBe('processing');
  });

  it('completeResearch finalizes the row', async () => {
    const id = db.generateId();
    await db.insertResearch(env.DB, { id, slug: 's-' + id, query: 'q2', canonicalQuery: 'q2' });
    await completeResearch(env.DB, { id, status: 'complete', summary: 'Sum', category: 'Cat', result: '{}', sources: '[]' });
    const row = await db.getResearchById(env.DB, id);
    expect(row.status).toBe('complete');
    expect(row.summary).toBe('Sum');
    expect(row.completed_at).toBeGreaterThan(0);
  });

  it('insertProductV2 + getProductsByResearchId (ordered by rank)', async () => {
    const rid = db.generateId();
    await db.insertResearch(env.DB, { id: rid, slug: 's-' + rid, query: 'q3', canonicalQuery: 'q3' });
    await insertProductV2(env.DB, { researchId: rid, name: 'Second', rank: 2, rating: 4 });
    await insertProductV2(env.DB, { researchId: rid, name: 'First', rank: 1, rating: 4.5, price: 10 });
    const { results } = await db.getProductsByResearchId(env.DB, rid);
    expect(results.map((p) => p.name)).toEqual(['First', 'Second']);
    expect(results[0].currency).toBe('USD'); // default applied
  });

  it('findResearchByCanonicalQuery requires a complete row WITH products', async () => {
    const rid = db.generateId();
    await db.insertResearch(env.DB, { id: rid, slug: 's-' + rid, query: 'mesh wifi', canonicalQuery: 'mesh-wifi-uniq' });
    // pending + no products → not found
    expect(await db.findResearchByCanonicalQuery(env.DB, 'mesh-wifi-uniq')).toBeNull();
    await completeResearch(env.DB, { id: rid, status: 'complete', summary: 's', category: 'c', result: '{}', sources: '[]' });
    // complete but still zero products → still not found (degenerate cluster guard)
    expect(await db.findResearchByCanonicalQuery(env.DB, 'mesh-wifi-uniq')).toBeNull();
    await insertProductV2(env.DB, { researchId: rid, name: 'P', rank: 1 });
    const found = await db.findResearchByCanonicalQuery(env.DB, 'mesh-wifi-uniq');
    expect(found.id).toBe(rid);
    // empty canonical → null short-circuit
    expect(await db.findResearchByCanonicalQuery(env.DB, '')).toBeNull();
  });

  it('applies optional-field defaults (tier, network, ipHash, comment, currency)', async () => {
    const id = db.generateId();
    // insertResearch with no tier/canonicalQuery/clarifications → tier defaults 'full'.
    await db.insertResearch(env.DB, { id, slug: 's-' + id, query: 'q-def' });
    const row = await db.getResearchById(env.DB, id);
    expect(row.tier).toBe('full');
    expect(row.canonical_query).toBeNull();

    const pid = db.generateId();
    // insertProductV2 with only the required fields → currency/pros/cons defaults.
    await insertProductV2(env.DB, { id: pid, researchId: id, name: 'Bare' });
    const { results } = await db.getProductsByResearchId(env.DB, id);
    expect(results[0].currency).toBe('USD');
    expect(results[0].pros).toBe('[]');

    // Click loggers with no network/ipHash → 'amazon' / '' defaults (no throw).
    await db.logAffiliateClick(env.DB, { productId: pid, reportId: id });
    await db.logGuideClick(env.DB, {});
    await db.insertFeedback(env.DB, { reportId: id, rating: 3 });
    const ac = await env.DB.prepare("SELECT affiliate_network FROM affiliate_clicks WHERE product_id = ?").bind(pid).first();
    expect(ac.affiliate_network).toBe('amazon');
  });

  it('logAffiliateClick + logGuideClick + insertFeedback persist rows', async () => {
    const rid = db.generateId();
    await db.insertResearch(env.DB, { id: rid, slug: 's-' + rid, query: 'q4', canonicalQuery: 'q4' });
    const pid = db.generateId();
    await insertProductV2(env.DB, { id: pid, researchId: rid, name: 'P', rank: 1 });

    await db.logAffiliateClick(env.DB, { productId: pid, reportId: rid, network: 'amazon', ipHash: 'h1' });
    const ac = await env.DB.prepare('SELECT COUNT(*) n FROM affiliate_clicks WHERE product_id = ?').bind(pid).first();
    expect(ac.n).toBe(1);

    await db.logGuideClick(env.DB, { guideSlug: 'best-nas', productQuery: 'nas', network: 'amazon', ipHash: 'h2' });
    const gc = await env.DB.prepare("SELECT COUNT(*) n FROM guide_clicks WHERE guide_slug = 'best-nas'").first();
    expect(gc.n).toBe(1);

    await db.insertFeedback(env.DB, { reportId: rid, rating: 5, comment: 'great' });
    const fb = await env.DB.prepare('SELECT rating, comment FROM feedback WHERE report_id = ?').bind(rid).first();
    expect(fb.rating).toBe(5);
    expect(fb.comment).toBe('great');
  });
});
