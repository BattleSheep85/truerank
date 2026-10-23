// CP-819 (batch 14): the processing-page notify box is honest while mail is
// off, and a worker-secret forceFresh run reads no cached SearXNG answer.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { renderResearchResult } from '../../worker/pages/research-page.js';
import { handleStartResearch } from '../../worker/handlers/research.js';
import { searchEnvFor } from '../../worker/jobs.js';

const SECRET = 'test-worker-secret-819';
const mailOn = { MAIL_ENABLED: 'true', TRUERANK_SMTP_USER: 'mailbox@example.test', TRUERANK_SMTP_PASSWORD: 'test-only-value' };

beforeAll(async () => {
  await applySchema(env.DB);
});

async function pendingSlug(query) {
  const id = generateId();
  await insertResearch(env.DB, { id, slug: `p-${id}`, query, canonicalQuery: `cp819-${id}` });
  return `p-${id}`;
}

describe('item 1: processing-page notify box follows the mail switch', () => {
  it('mail off: no email offer and no form, but the wait is explained', async () => {
    const slug = await pendingSlug('cp819 mail off widget');
    const { html } = await renderResearchResult(slug, { ...env, MAIL_ENABLED: 'false' });
    expect(html).toContain('id="processing"');
    expect(html).not.toContain('Want an email');
    expect(html).not.toContain('id="notify-form"');
    expect(html).toMatch(/Email alerts are not switched on yet/);
  });

  it('mail on but no SMTP secrets counts as off', async () => {
    const slug = await pendingSlug('cp819 no secret widget');
    const { html } = await renderResearchResult(slug, { ...env, MAIL_ENABLED: 'true', TRUERANK_SMTP_USER: '', TRUERANK_SMTP_PASSWORD: '' });
    expect(html).not.toContain('Want an email');
  });

  it('mail on: the offer and the form stay', async () => {
    const slug = await pendingSlug('cp819 mail on widget');
    const { html } = await renderResearchResult(slug, { ...env, ...mailOn });
    expect(html).toContain('Want an email');
    expect(html).toContain('id="notify-form"');
  });
});

describe('item 3a: forceFresh skips the SearXNG cache read', () => {
  const sent = [];
  const testEnv = { ...env, WORKER_SECRET: SECRET, RESEARCH_QUEUE: { send: async (msg) => { sent.push(msg); } } };
  const post = (body, headers = {}) => new Request('https://chrisputer.tech/api/research', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.219', ...headers },
    body: JSON.stringify(body),
  });

  it('a worker-secret forceFresh run asks the queue to bypass the search cache', async () => {
    sent.length = 0;
    const res = await handleStartResearch(post({ query: 'cp819 fresh bench widget', forceFresh: true }, { 'X-Worker-Secret': SECRET }), testEnv);
    expect((await res.json()).status).toBe('pending');
    expect(sent).toHaveLength(1);
    expect(sent[0].bypassSearchCache).toBe(true);
  });

  it('a public forceFresh or fresh run does not', async () => {
    sent.length = 0;
    await handleStartResearch(post({ query: 'cp819 public fresh widget', forceFresh: true, fresh: true }), testEnv);
    expect(sent).toHaveLength(1);
    expect(sent[0].bypassSearchCache).toBeUndefined();
  });

  it('searchEnvFor sets the bypass only for a literal true', () => {
    expect(searchEnvFor(env, { bypassSearchCache: true }).SEARXNG_CACHE_BYPASS).toBe(true);
    expect(searchEnvFor(env, { bypassSearchCache: true }).DB).toBe(env.DB);
    expect(searchEnvFor(env, { bypassSearchCache: 'true' })).toBe(env);
    expect(searchEnvFor(env, {})).toBe(env);
    expect(searchEnvFor(env, undefined)).toBe(env);
  });
});
