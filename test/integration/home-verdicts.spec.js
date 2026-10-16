// Integration coverage for the homepage "Recent verdicts" section (piece 12):
// worker/pages/home.js recentVerdictsSection against a real D1. Mirrors the
// D1 conventions of verify-route.spec.js and consent-routes.spec.js.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId } from '../../worker/lib/db.js';
import { overallVerdict } from '../../worker/lib/verdict.js';
import * as home from '../../worker/pages/home.js';

// Namespace import: recentVerdictsSection, VERDICTS_MARKER, and
// MIN_VERDICTS_TO_SHOW can be missing from home.js until piece 12 lands.
const section = (...args) => home.recentVerdictsSection(...args);

const nowSec = () => Math.floor(Date.now() / 1000);

const claim = (status, claimType = 'spec') => ({ text: `claim ${status}`, status, claimType });

// 3 decided of 4 claims: verified, verified, contradicted, unsubstantiated.
const QUALIFYING_CLAIMS = [claim('verified'), claim('verified'), claim('contradicted'), claim('unsubstantiated')];
const TWO_CLAIMS = [claim('verified'), claim('verified')];
const NO_DECIDED_CLAIMS = [claim('unsubstantiated'), claim('unsubstantiated'), claim('unsubstantiated')];

async function seedVerdict({ slug, query = 'Seeded Verdict Product', status = 'complete', result, ageSec = 3600 }) {
  const id = generateId();
  const completedAt = status === 'complete' ? nowSec() - ageSec : null;
  await env.DB.prepare(
    `INSERT INTO research (id, slug, query, status, kind, result, created_at, completed_at)
     VALUES (?1, ?2, ?3, ?4, 'verification', ?5, ?6, ?7)`
  ).bind(id, slug, query, status, result, nowSec() - ageSec - 600, completedAt).run();
  return id;
}

const verifyHrefs = (html) => [...html.matchAll(/href="\/verify\/([^"]+)"/g)].map((m) => m[1]);

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM research WHERE kind = 'verification'").run();
});

describe('home.js constants (piece 12)', () => {
  it('exports the marker and the minimum count', () => {
    expect(home.VERDICTS_MARKER).toBe('<!--RECENT_VERDICTS-->');
    expect(home.MIN_VERDICTS_TO_SHOW).toBe(3);
  });
});

describe('recentVerdictsSection (piece 12)', () => {
  it('lists exactly the 3 qualifying verdicts, newest first', async () => {
    await seedVerdict({ slug: 'verify-old-qualifier', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 3 * 3600 });
    await seedVerdict({ slug: 'verify-two-claims', result: JSON.stringify({ claims: TWO_CLAIMS }), ageSec: 30 });
    await seedVerdict({ slug: 'verify-newest-qualifier', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 });
    await seedVerdict({ slug: 'verify-no-decided', result: JSON.stringify({ claims: NO_DECIDED_CLAIMS }), ageSec: 90 });
    await seedVerdict({ slug: 'verify-mid-qualifier', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 2 * 3600 });
    await seedVerdict({ slug: 'verify-pending', status: 'pending', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }) });

    const html = await section(env);
    expect(verifyHrefs(html)).toEqual(['verify-newest-qualifier', 'verify-mid-qualifier', 'verify-old-qualifier']);

    const expected = overallVerdict(QUALIFYING_CLAIMS);
    expect(html).toContain('Recent verdicts');
    expect(html).toContain(`${expected.score}/100`);
    expect(html).toContain(expected.label);
    expect(html).toContain(`${expected.checkedCount} of ${expected.claimCount} claims checked`);
    expect(html).toContain('Checked ');
    expect(html).toContain('class="card"');
  });

  it('gives an empty string when only 2 verdicts qualify', async () => {
    await seedVerdict({ slug: 'verify-only-a', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 });
    await seedVerdict({ slug: 'verify-only-b', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 120 });
    await seedVerdict({ slug: 'verify-only-two-claims', result: JSON.stringify({ claims: TWO_CLAIMS }), ageSec: 180 });

    expect(await section(env)).toBe('');
  });

  it('skips a row with malformed result JSON and does not throw', async () => {
    await seedVerdict({ slug: 'verify-malformed', result: '{"claims": [', ageSec: 30 });
    await seedVerdict({ slug: 'verify-good-a', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 });
    await seedVerdict({ slug: 'verify-good-b', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 120 });
    await seedVerdict({ slug: 'verify-good-c', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 180 });

    const html = await section(env);
    expect(verifyHrefs(html)).toEqual(['verify-good-a', 'verify-good-b', 'verify-good-c']);
  });

  it('escapes the product name', async () => {
    await seedVerdict({ slug: 'verify-escape-a', query: '<b>x</b> widget', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 });
    await seedVerdict({ slug: 'verify-escape-b', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 120 });
    await seedVerdict({ slug: 'verify-escape-c', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 180 });

    const html = await section(env);
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
  });

  it('gives an empty string when env.DB.prepare throws', async () => {
    const brokenEnv = { ...env, DB: { prepare() { throw new Error('D1 unavailable'); } } };
    await expect(section(brokenEnv)).resolves.toBe('');
  });

  it('keeps at most `limit` cards', async () => {
    for (let i = 0; i < 5; i++) {
      await seedVerdict({ slug: `verify-limit-${i}`, result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 * (i + 1) });
    }
    const html = await section(env, 3);
    expect(verifyHrefs(html)).toEqual(['verify-limit-0', 'verify-limit-1', 'verify-limit-2']);
  });

  it('filters out untestable store/SKU/warranty claims via isTestableClaim so homepage cards match report pages', async () => {
    // Row with 2 testable claims + 3 untestable store/SKU/warranty claims -> only 2 testable (< MIN_VERDICT_CLAIMS=3), must NOT qualify!
    const hollowedOutClaims = [
      { text: 'Offers 30 hours of battery life', status: 'verified', claimType: 'spec' },
      { text: 'IPX4 water resistance rating', status: 'verified', claimType: 'spec' },
      { text: 'Sold by third-party seller Electronics Club on Amazon', status: 'verified', claimType: 'spec' },
      { text: 'Manufacturer part number is 4Y9DY and order code is 210-BFSC', status: 'verified', claimType: 'spec' },
      { text: '1-year limited warranty coverage', status: 'verified', claimType: 'warranty' },
    ];
    await seedVerdict({ slug: 'verify-hollowed-out', result: JSON.stringify({ claims: hollowedOutClaims }), ageSec: 10 });

    // Row with 3 testable claims + 2 untestable claims -> qualifies with claimCount = 3 (not 5)
    const mixedQualifyingClaims = [
      { text: 'Offers 30 hours of battery life', status: 'verified', claimType: 'spec' },
      { text: 'IPX4 water resistance rating', status: 'verified', claimType: 'spec' },
      { text: 'Multipoint Bluetooth 5.3 connection', status: 'partially-verified', claimType: 'spec' },
      { text: 'Priced at $459.99 MSRP', status: 'contradicted', claimType: 'spec' },
      { text: 'Costco item 1603480', status: 'contradicted', claimType: 'spec' },
    ];
    await seedVerdict({ slug: 'verify-mixed-clean', result: JSON.stringify({ claims: mixedQualifyingClaims }), ageSec: 20 });
    await seedVerdict({ slug: 'verify-clean-b', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 60 });
    await seedVerdict({ slug: 'verify-clean-c', result: JSON.stringify({ claims: QUALIFYING_CLAIMS }), ageSec: 120 });

    const html = await section(env);
    expect(verifyHrefs(html)).toEqual(['verify-mixed-clean', 'verify-clean-b', 'verify-clean-c']);
    expect(html).not.toContain('verify-hollowed-out');
    // verify-mixed-clean card shows "3 of 3 claims checked", not "5 of 5 claims checked"
    expect(html).toContain('3 of 3 claims checked');
    expect(html).not.toContain('5 of 5 claims checked');
  });
});
