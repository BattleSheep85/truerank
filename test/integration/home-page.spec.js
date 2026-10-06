// Integration coverage for the verify-first homepage (piece 13): GET / through
// the real worker (SELF.fetch), which serves public/index.html through ASSETS
// and swaps the recent-verdicts marker. Mirrors consent-routes.spec.js.
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId } from '../../worker/lib/db.js';

const BASE = 'https://chrisputer.tech';
const VERDICT_SLUGS = ['verify-home-alpha', 'verify-home-bravo', 'verify-home-charlie'];

// 3 decided of 4 claims, so overallVerdict gives a numeric score.
const QUALIFYING_RESULT = JSON.stringify({
  claims: [
    { text: 'claim one', status: 'verified', claimType: 'spec' },
    { text: 'claim two', status: 'verified', claimType: 'spec' },
    { text: 'claim three', status: 'contradicted', claimType: 'spec' },
    { text: 'claim four', status: 'unsubstantiated', claimType: 'spec' },
  ],
});

beforeAll(async () => {
  await applySchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  for (const [i, slug] of VERDICT_SLUGS.entries()) {
    await env.DB.prepare(
      `INSERT INTO research (id, slug, query, status, kind, result, created_at, completed_at)
       VALUES (?1, ?2, ?3, 'complete', 'verification', ?4, ?5, ?6)`
    ).bind(generateId(), slug, `Home Verdict Product ${i}`, QUALIFYING_RESULT, now - 3600, now - 60 * (i + 1)).run();
  }
});

async function getHome() {
  const res = await SELF.fetch(new Request(`${BASE}/`, { cf: { country: 'US' } }));
  return { res, html: await res.text() };
}

// The body of the first <form> whose opening tag carries the given id.
function formBlock(html, id) {
  const start = html.search(new RegExp(`<form[^>]*\\bid="${id}"`));
  if (start === -1) return null;
  const end = html.indexOf('</form>', start);
  return html.slice(start, end === -1 ? undefined : end + '</form>'.length);
}

describe('GET / verify-first homepage (piece 13)', () => {
  it('serves the hero verify form with action /verify and a 2048-character input', async () => {
    const { res, html } = await getHome();
    expect(res.status).toBe(200);

    const hero = formBlock(html, 'verify-hero-form');
    expect(hero).not.toBeNull();
    const openTag = hero.slice(0, hero.indexOf('>') + 1);
    expect(openTag).toContain('action="/verify"');
    expect(openTag).toContain('method="get"');
    expect(hero).toContain('name="product"');
    expect(hero).toContain('maxlength="2048"');
  });

  it('has no example chip that starts with "best"', async () => {
    const { html } = await getHome();
    expect(html).not.toMatch(/data-query="best/i);
  });

  it('leaves no section marker in the output', async () => {
    const { html } = await getHome();
    expect(html).not.toContain('<!--RECENT_VERDICTS-->');
    expect(html).not.toContain('<!--RECENT_REPORTS-->');
  });

  it('shows the recent verdicts section with the 3 seeded verdict links', async () => {
    const { html } = await getHome();
    expect(html).toContain('Recent verdicts');
    for (const slug of VERDICT_SLUGS) {
      expect(html).toContain(`href="/verify/${slug}"`);
    }
  });

  it('puts the CSP nonce on every inline script', async () => {
    const { res, html } = await getHome();
    const csp = res.headers.get('Content-Security-Policy') || '';
    const nonce = (csp.match(/'nonce-([^']+)'/) || [])[1];
    expect(nonce).toBeTruthy();

    const inlineScripts = [...html.matchAll(/<script\b([^>]*)>/g)]
      .map((m) => m[1])
      .filter((attrs) => !/\bsrc=/.test(attrs) && !/type="application\/(?:ld\+)?json"/.test(attrs));
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const attrs of inlineScripts) {
      expect(attrs).toContain(`nonce="${nonce}"`);
    }
  });
});
