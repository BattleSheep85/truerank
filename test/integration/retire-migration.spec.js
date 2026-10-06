// Integration coverage for migration 017 (plan piece 2, spec D1 and 4.1).
// applySchema adds the retired_at and retired_reason columns (017 is the last
// file in its list). This spec seeds rows, then runs only the UPDATE statements
// of 017, and checks that the backfill retires exactly the rows that
// runFlywheelTick created: a keyword_queue link plus query = LOWER(TRIM(keyword)),
// no clarifications, and no user_searches or subscribers link.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import migration017 from '../../schema/017_retire_seo_rows.sql?raw';

const RETIRED_REASON = 'seo-flywheel';
const SENTINEL_RETIRED_AT = 1000;

// Same parse rule as _schema.js applySchema: strip `--` comments, split on `;`.
const UPDATE_STATEMENTS = migration017
  .replace(/--[^\n]*/g, '')
  .split(';')
  .map((s) => s.trim())
  .filter((s) => /^UPDATE\b/i.test(s));

async function runBackfill() {
  for (const sql of UPDATE_STATEMENTS) await env.DB.prepare(sql).run();
}

async function seedResearch(query, { kind = null } = {}) {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: 's-' + id, query, canonicalQuery: 'retire-' + id });
  if (kind) await env.DB.prepare('UPDATE research SET kind = ?1 WHERE id = ?2').bind(kind, id).run();
  return id;
}

async function seedKeyword(keyword, { researchId = null, status = 'done' } = {}) {
  await env.DB.prepare(
    'INSERT INTO keyword_queue (keyword, status, research_id, created_at) VALUES (?1, ?2, ?3, ?4)'
  ).bind(keyword, status, researchId, Math.floor(Date.now() / 1000)).run();
}

async function retiredOf(id) {
  return env.DB.prepare('SELECT retired_at, retired_reason FROM research WHERE id = ?').bind(id).first();
}

const ids = {};

beforeAll(async () => {
  await applySchema(env.DB);
  ids.a = await seedResearch('best nas for plex');
  await seedKeyword(' Best NAS for Plex ', { researchId: ids.a });
  ids.b = await seedResearch('cheap widgets for my desk');
  await seedKeyword('best widget under $50', { researchId: ids.b });
  ids.c = await seedResearch('best gizmo 2026');
  ids.d = await seedResearch('sony wh-1000xm6', { kind: 'verification' });
  await seedKeyword('sony wh-1000xm6', { researchId: ids.d });
  await seedKeyword('best tent', { status: 'failed' });
  await runBackfill();
});

describe('migration 017 backfill', () => {
  it('has at least one UPDATE statement', () => {
    expect(UPDATE_STATEMENTS.length).toBeGreaterThan(0);
  });

  it('A: retires a flywheel-made row', async () => {
    const row = await retiredOf(ids.a);
    expect(row.retired_reason).toBe(RETIRED_REASON);
    expect(Number.isInteger(row.retired_at)).toBe(true);
  });

  it.each([
    ['B: clustered keyword with a different query', 'b'],
    ['C: best-shaped query with no keyword link', 'c'],
    ['D: verification row with the same query as its keyword', 'd'],
  ])('%s stays live', async (_label, key) => {
    const row = await retiredOf(ids[key]);
    expect(row.retired_at).toBeNull();
    expect(row.retired_reason).toBeNull();
  });

  it('E: a keyword with no research_id retires nothing extra', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM research WHERE retired_at IS NOT NULL').first();
    expect(row.n).toBe(1);
  });

  it('a second run does not change retired_at on row A', async () => {
    await env.DB.prepare('UPDATE research SET retired_at = ?1 WHERE id = ?2').bind(SENTINEL_RETIRED_AT, ids.a).run();
    await runBackfill();
    const row = await retiredOf(ids.a);
    expect(row.retired_at).toBe(SENTINEL_RETIRED_AT);
    expect(row.retired_reason).toBe(RETIRED_REASON);
  });

  it('a row that insertResearch creates is live', async () => {
    const id = await seedResearch('fresh row after migration');
    const row = await retiredOf(id);
    expect(row.retired_at).toBeNull();
    expect(row.retired_reason).toBeNull();
  });
});

describe('migration 017 backfill: rows a person made', () => {
  const user = {};

  async function seedUser() {
    const id = 'u-' + generateId();
    await env.DB.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(id, id + '@example.test', 'pbkdf2$1$x$y', Math.floor(Date.now() / 1000)).run();
    return id;
  }

  // Same shape as the runFlywheelTick clustered branch: status 'done', research_id, done_at.
  async function clusterKeyword(keyword, researchId) {
    await env.DB.prepare(
      'INSERT INTO keyword_queue (keyword, status, research_id, created_at, done_at) VALUES (?1, ?2, ?3, ?4, ?4)'
    ).bind(keyword, 'done', researchId, Math.floor(Date.now() / 1000)).run();
  }

  beforeAll(async () => {
    const userId = await seedUser();
    user.searched = await seedResearch('best dog food for puppies');
    await env.DB.prepare('INSERT INTO user_searches (user_id, research_id, query, created_at) VALUES (?1, ?2, ?3, ?4)')
      .bind(userId, user.searched, 'best dog food for puppies', Math.floor(Date.now() / 1000)).run();
    await clusterKeyword('Best Dog Food for Puppies', user.searched);

    user.subscribed = await seedResearch('best cat litter');
    await env.DB.prepare('INSERT INTO subscribers (email, research_id, created_at) VALUES (?1, ?2, ?3)')
      .bind('reader@example.test', user.subscribed, Math.floor(Date.now() / 1000)).run();
    await clusterKeyword('best cat litter', user.subscribed);

    user.clarified = await seedResearch('best robot vacuum');
    await env.DB.prepare('UPDATE research SET clarifications = ?1 WHERE id = ?2')
      .bind(JSON.stringify({ budget: 'under 300' }), user.clarified).run();
    await clusterKeyword('best robot vacuum', user.clarified);

    user.flywheel = await seedResearch('best trail running shoes');
    await clusterKeyword('best trail running shoes', user.flywheel);

    await runBackfill();
  });

  it.each([
    ['review: clustered user row not retired', 'searched'],
    ['review: subscribed row not retired', 'subscribed'],
    ['review: clarified row not retired', 'clarified'],
  ])('%s', async (_label, key) => {
    const row = await retiredOf(user[key]);
    expect(row.retired_at).toBeNull();
    expect(row.retired_reason).toBeNull();
  });

  it('review: flywheel row with done_at set and no person link is retired', async () => {
    const row = await retiredOf(user.flywheel);
    expect(row.retired_reason).toBe(RETIRED_REASON);
  });
});
