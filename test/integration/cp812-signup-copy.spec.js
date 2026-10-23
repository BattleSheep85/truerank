// CP-812: while outbound mail is off, the signup form must not tell the
// visitor to check an inbox. The API says whether mail is on (the same answer
// for every address, so it reveals nothing about one), and the page script
// shows the honest message.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { handleSubscribe } from '../../worker/handlers/subscribe.js';
import { subscribeScript } from '../../worker/pages/research-scripts.js';

beforeAll(() => applySchema(env.DB));
beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
});

// Each test uses its own client IP: RL_BURST is not reset between tests.
const post = (email, ip) => new Request('https://x/api/subscribe', {
  method: 'POST',
  body: JSON.stringify({ email }),
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
});

const stubTransport = async () => ({ ok: true, response: '250 queued' });
const mailOnEnv = () => ({
  ...env,
  MAIL_ENABLED: 'true',
  TRUERANK_SMTP_USER: 'mailbox@example.test',
  TRUERANK_SMTP_PASSWORD: 'test-only-value',
  __mailTransport: stubTransport,
});

describe('signup answer says whether mail is on', () => {
  it('mail off (MAIL_ENABLED false): ok with mail "off", and the row is saved', async () => {
    const res = await handleSubscribe(post('off@example.test', '10.8.12.1'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mail: 'off' });
    const row = await env.DB.prepare("SELECT id FROM subscribers WHERE email = 'off@example.test'").first();
    expect(row).toBeTruthy();
  });

  it('mail switched on but no SMTP secrets: still "off"', async () => {
    const res = await handleSubscribe(post('nosecret@example.test', '10.8.12.2'), { ...env, MAIL_ENABLED: 'true' });
    expect(await res.json()).toEqual({ ok: true, mail: 'off' });
  });

  it('mail on: the plain {ok:true} answer is unchanged', async () => {
    const res = await handleSubscribe(post('on@example.test', '10.8.12.3'), mailOnEnv());
    expect(await res.json()).toEqual({ ok: true });
  });

  it('a bad address is still refused the same way with mail off', async () => {
    const res = await handleSubscribe(post('nope', '10.8.12.4'), env);
    expect(res.status).toBe(400);
  });
});

describe('signup page script copy', () => {
  const script = subscribeScript('abcdefgh12345678');

  it('promises an inbox mail only when mail is on', () => {
    expect(script).toContain("d.mail==='off'");
    expect(script).toMatch(/d\.mail==='off'\?'[^']*'/);
    const offCopy = script.match(/d\.mail==='off'\?'([^']*)'/)[1];
    expect(offCopy.toLowerCase()).not.toContain('inbox');
    expect(offCopy.toLowerCase()).not.toContain('check your');
    // Double opt-in: nothing confirms the address while mail is off, so the
    // copy must not say the signup worked.
    expect(offCopy.toLowerCase()).not.toMatch(/saved|subscribed|signed up/);
    expect(offCopy.toLowerCase()).toContain('try again later');
    expect(script).toContain('Check your inbox and click the link to confirm.');
  });
});
