// Integration coverage for migration 023 (CP-341). 017 retires a row that a
// person made when a keyword with the same text clustered onto it. 023 brings
// back a 'seo-flywheel' row created 120 seconds or more after a 10-minute
// mark, because the */10 cron (runFlywheelTick) cannot have inserted it.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import migration023 from '../../schema/023_unretire_person_rows.sql?raw';

const TICK = 1782480000; // a 10-minute mark (divisible by 600)
const RETIRED_AT = 1791387102;

// Same parse rule as _schema.js applySchema: strip `--` comments, split on `;`.
const STATEMENTS = migration023
  .replace(/--[^\n]*/g, '')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

async function runMigration() {
  for (const sql of STATEMENTS) await env.DB.prepare(sql).run();
}

async function seedRetired(query, createdAt, reason = 'seo-flywheel') {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: 's-' + id, query, canonicalQuery: 'c-' + id });
  await env.DB.prepare('UPDATE research SET created_at = ?1, retired_at = ?2, retired_reason = ?3 WHERE id = ?4')
    .bind(createdAt, RETIRED_AT, reason, id).run();
  return id;
}

async function retiredOf(id) {
  return env.DB.prepare('SELECT retired_at, retired_reason FROM research WHERE id = ?').bind(id).first();
}

const ids = {};

beforeAll(async () => {
  await applySchema(env.DB);
  ids.person = await seedRetired('best espresso machine under $500', TICK + 390);
  ids.edge = await seedRetired('best espresso grinder', TICK + 120);
  ids.cron = await seedRetired('best milk frother', TICK + 68);
  ids.cronLate = await seedRetired('best kettle', TICK + 119);
  ids.testRun = await seedRetired('best kettle diagnostic 20260621', TICK + 390, 'test-run');
  await runMigration();
});

describe('migration 023: un-retire rows a person made', () => {
  it.each([
    ['a row created 390 s after a mark comes back', 'person'],
    ['a row created 120 s after a mark comes back', 'edge'],
  ])('%s', async (_label, key) => {
    const row = await retiredOf(ids[key]);
    expect(row.retired_at).toBeNull();
    expect(row.retired_reason).toBeNull();
  });

  it.each([
    ['a row created 68 s after a mark stays retired', 'cron'],
    ['a row created 119 s after a mark stays retired', 'cronLate'],
  ])('%s', async (_label, key) => {
    const row = await retiredOf(ids[key]);
    expect(row.retired_at).toBe(RETIRED_AT);
    expect(row.retired_reason).toBe('seo-flywheel');
  });

  it('a row retired for another reason stays retired', async () => {
    const row = await retiredOf(ids.testRun);
    expect(row.retired_reason).toBe('test-run');
  });

  it('a second run changes nothing', async () => {
    await runMigration();
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM research WHERE retired_at IS NOT NULL').first();
    expect(row.n).toBe(3);
  });
});
