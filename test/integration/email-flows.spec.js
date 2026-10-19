// Integration coverage for the email flows on Miniflare-backed D1 + KV.
//
// NO TEST HERE CAN SEND REAL MAIL. Two independent guards:
//   1. The harness env has MAIL_ENABLED = "false" (from wrangler.toml) and no
//      Resend key, so an un-stubbed path degrades to a logged skip.
//   2. Every sending test runs against a COPY of env that carries a recording
//      stub at `env.__mailTransport`, which is the seam sendMail resolves
//      before it ever reaches worker/lib/resend.js. No request leaves.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { applySchema } from './_schema.js';
import { completeResearch } from './_helpers.js';
import { handleSubscribe } from '../../worker/handlers/subscribe.js';
import { handleConfirm } from '../../worker/handlers/confirm.js';
import { handleUnsubscribe } from '../../worker/handlers/unsubscribe.js';
import { notifySubscribersForResearch } from '../../worker/lib/notify.js';
import { sendMail, mailConfigured, dailyCounterKey } from '../../worker/lib/mailer.js';
import { generateId, insertResearch } from '../../worker/lib/db.js';
import { CONFIRM_TTL_S } from '../../worker/lib/subscribe-flow.js';

beforeAll(() => applySchema(env.DB));

// The Workers plugin does not reset D1 or KV between tests in one file. Each
// test starts from an empty schema and empty KV (rate-limit timestamps and the
// mail:sent:<date> daily counter), as it did under the old isolatedStorage.
// No describe here seeds data in a beforeAll, so a full reset is safe.
// Delete every KV key, page by page.
async function clearKv(kv) {
  let cursor;
  do {
    const page = await kv.list({ cursor });
    await Promise.all(page.keys.map((k) => kv.delete(k.name)));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM subscribers').run();
  await env.DB.prepare('DELETE FROM products').run();
  await env.DB.prepare('DELETE FROM research').run();
  await clearKv(env.KV);
});

// Flatten a Resend payload into header lines plus both bodies, so a spec can
// search one string for a subject, a header, or a link.
function flatten(payload) {
  const headers = Object.entries(payload.headers).map(([k, v]) => `${k}: ${v}`);
  return [`Subject: ${payload.subject}`, ...headers, '', payload.text, payload.html].join('\n');
}

// A transport that records the recipient and the message. It NEVER stores the
// API key it is handed.
function recordingTransport(behaviour = 'ok') {
  const calls = [];
  const transport = async (cfg, payload) => {
    calls.push({ to: cfg.to, payload, raw: flatten(payload) });
    if (behaviour === 'throw') throw new Error('resend refused');
    return { ok: true, response: 'msg_TEST' };
  };
  return { calls, transport };
}

// A copy of the worker env with mail switched on and the seam attached. The
// stub is mandatory: without it the default transport would open a socket.
const mailEnv = (transport) => {
  if (typeof transport !== 'function') throw new Error('mailEnv needs a stub transport. No spec may use the real one.');
  return {
    ...env,
    MAIL_ENABLED: 'true',
    TRUERANK_RESEND_API_KEY: 'test-only-value',
    __mailTransport: transport,
  };
};

// The RL_BURST binding is NOT storage-isolated per test (10 per 60 s per key),
// so every test that posts a signup uses its own client IP.
const postJson = (body, ip = '9.9.9.9') => new Request('https://x/api/subscribe', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
});

// Both bodies of one recorded send, joined.
const readableBody = (call) => `${call.payload.text}\n${call.payload.html}`;

const tokenFor = (email) => env.DB.prepare('SELECT confirm_token FROM subscribers WHERE email = ?1').bind(email).first();

describe('subscribe: double opt-in', () => {
  it('stores an unconfirmed row and sends exactly one confirmation', async () => {
    const rid = generateId();
    const { calls, transport } = recordingTransport();
    const res = await handleSubscribe(postJson({ email: 'new@example.test', researchId: rid }, '10.0.0.1'), mailEnv(transport));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const row = await env.DB.prepare("SELECT * FROM subscribers WHERE email = 'new@example.test'").first();
    expect(row.confirmed_at).toBe(null);
    expect(row.confirm_token).toBeTruthy();
    expect(row.unsub_token).toBeTruthy();
    expect(row.confirm_sent_at).toBeGreaterThan(0);
    expect(row.confirm_send_count).toBe(1);

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('new@example.test');
    expect(readableBody(calls[0])).toContain(`https://chrisputer.tech/confirm?token=${row.confirm_token}`);
    expect(calls[0].raw).toContain('Subject: Confirm your Frank email notification');
  });

  it('names the research query in the confirmation when there is one', async () => {
    const id = generateId();
    await insertResearch(env.DB, { id, slug: `s-${id}`, query: 'best standing desks', canonicalQuery: 'q' });
    const { calls, transport } = recordingTransport();
    await handleSubscribe(postJson({ email: 'ctx@example.test', researchId: id }, '10.0.0.2'), mailEnv(transport));
    expect(readableBody(calls[0])).toContain('best standing desks');
  });

  it('a repeat signup inside the cooldown sends nothing and still answers ok', async () => {
    const rid = generateId();
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    await handleSubscribe(postJson({ email: 'dup@example.test', researchId: rid }, '10.0.0.3'), mail);
    const second = await handleSubscribe(postJson({ email: 'dup@example.test', researchId: rid }, '10.0.0.3'), mail);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    const count = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE email = 'dup@example.test'").first();
    expect(count.n).toBe(1);
  });

  it('a second report for a confirmed address is added with no new mail', async () => {
    const ridA = generateId();
    const ridB = generateId();
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    await handleSubscribe(postJson({ email: 'proven@example.test', researchId: ridA }, '10.0.0.4'), mail);
    const token = (await tokenFor('proven@example.test')).confirm_token;
    await handleConfirm(new Request(`https://x/confirm?token=${token}`), mail);
    await handleSubscribe(postJson({ email: 'proven@example.test', researchId: ridB }, '10.0.0.4'), mail);

    const rows = await env.DB.prepare("SELECT research_id, confirmed_at FROM subscribers WHERE email = 'proven@example.test' ORDER BY research_id").all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((r) => r.confirmed_at != null)).toBe(true);
    expect(calls).toHaveLength(1); // only the first confirmation
  });

  it('a failed send leaves confirm_sent_at unset so the next submit retries', async () => {
    const rid = generateId();
    const { transport } = recordingTransport('throw');
    await handleSubscribe(postJson({ email: 'retry@example.test', researchId: rid }, '10.0.0.5'), mailEnv(transport));
    const row = await env.DB.prepare("SELECT confirm_sent_at, confirm_send_count FROM subscribers WHERE email = 'retry@example.test'").first();
    expect(row.confirm_sent_at).toBe(null);
    expect(row.confirm_send_count).toBe(0);
  });

  it('rate limits a burst from one IP with a Retry-After', async () => {
    const { transport } = recordingTransport();
    const mail = mailEnv(transport);
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push(await handleSubscribe(postJson({ email: `burst${i}@example.test` }, '5.5.5.5'), mail));
    }
    const blocked = results.filter((r) => r.status === 429);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].headers.get('Retry-After')).toBeTruthy();
  });
});

describe('confirm route', () => {
  it('confirms every pending row of the address and is idempotent', async () => {
    const rid1 = generateId();
    const rid2 = generateId();
    const { transport } = recordingTransport();
    const mail = mailEnv(transport);
    await handleSubscribe(postJson({ email: 'multi@example.test', researchId: rid1 }, '10.0.0.6'), mail);
    await handleSubscribe(postJson({ email: 'multi@example.test', researchId: rid2 }, '10.0.0.6'), mail);
    const token = (await tokenFor('multi@example.test')).confirm_token;

    const res = await handleConfirm(new Request(`https://x/confirm?token=${token}`), mail);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Email confirmed');

    const rows = await env.DB.prepare("SELECT confirmed_at FROM subscribers WHERE email = 'multi@example.test'").all();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((r) => r.confirmed_at != null)).toBe(true);

    const again = await handleConfirm(new Request(`https://x/confirm?token=${token}`), mail);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain('Email confirmed');
  });

  it('rejects a missing or unknown token', async () => {
    expect((await handleConfirm(new Request('https://x/confirm'), env)).status).toBe(400);
    expect((await handleConfirm(new Request('https://x/confirm?token=nope'), env)).status).toBe(404);
  });

  it('refuses an expired link and changes nothing', async () => {
    const rid = generateId();
    const { transport } = recordingTransport();
    await handleSubscribe(postJson({ email: 'old@example.test', researchId: rid }, '10.0.0.7'), mailEnv(transport));
    const token = (await tokenFor('old@example.test')).confirm_token;
    const stale = Math.floor(Date.now() / 1000) - CONFIRM_TTL_S - 60;
    await env.DB.prepare("UPDATE subscribers SET confirm_sent_at = ?1 WHERE email = 'old@example.test'").bind(stale).run();

    const res = await handleConfirm(new Request(`https://x/confirm?token=${token}`), env);
    expect(await res.text()).toContain('Link expired');
    const row = await env.DB.prepare("SELECT confirmed_at FROM subscribers WHERE email = 'old@example.test'").first();
    expect(row.confirmed_at).toBe(null);
  });
});

describe('notify: report ready', () => {
  const seed = async (researchId, rows) => {
    await insertResearch(env.DB, { id: researchId, slug: `slug-${researchId}`, query: 'best office chairs', canonicalQuery: researchId });
    await completeResearch(env.DB, { id: researchId });
    for (const r of rows) {
      await env.DB.prepare(
        `INSERT INTO subscribers (email, research_id, created_at, unsub_token, confirmed_at, unsubscribed_at, confirm_send_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`,
      ).bind(r.email, researchId, 1, r.unsubToken ?? `t-${r.email}`, r.confirmedAt ?? null, r.unsubscribedAt ?? null).run();
    }
  };

  it('mails only the confirmed active subscriber and stamps last_notified_at', async () => {
    const rid = generateId();
    await seed(rid, [
      { email: 'yes@example.test', confirmedAt: 100, unsubToken: 'tok-yes' },
      { email: 'pending@example.test' },
      { email: 'gone@example.test', confirmedAt: 100, unsubscribedAt: 200 },
    ]);
    const { calls, transport } = recordingTransport();
    const result = await notifySubscribersForResearch(mailEnv(transport), { researchId: rid, query: 'best office chairs', slug: `slug-${rid}` });

    expect(result).toEqual({ sent: 1, failed: 0, skipped: 0, reason: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('yes@example.test');
    expect(calls[0].raw).toContain('List-Unsubscribe: <https://chrisputer.tech/unsubscribe?token=tok-yes>');
    expect(calls[0].raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(readableBody(calls[0])).toContain(`https://chrisputer.tech/research/slug-${rid}`);

    const row = await env.DB.prepare("SELECT last_notified_at FROM subscribers WHERE email = 'yes@example.test'").first();
    expect(row.last_notified_at).toBeGreaterThan(0);
  });

  it('honours the one-hour dedupe on a second call', async () => {
    const rid = generateId();
    await seed(rid, [{ email: 'once@example.test', confirmedAt: 100 }]);
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    await notifySubscribersForResearch(mail, { researchId: rid, query: 'q', slug: `slug-${rid}` });
    const second = await notifySubscribersForResearch(mail, { researchId: rid, query: 'q', slug: `slug-${rid}` });
    expect(calls).toHaveLength(1);
    expect(second).toEqual({ sent: 0, failed: 0, skipped: 0, reason: 'no-recipients' });
  });

  it('issues an unsubscribe token for a grandfathered row that has none', async () => {
    const rid = generateId();
    await seed(rid, [{ email: 'legacy@example.test', confirmedAt: 100, unsubToken: null }]);
    const { calls, transport } = recordingTransport();
    await notifySubscribersForResearch(mailEnv(transport), { researchId: rid, query: 'q', slug: `slug-${rid}` });
    const row = await env.DB.prepare("SELECT unsub_token FROM subscribers WHERE email = 'legacy@example.test'").first();
    expect(row.unsub_token).toBeTruthy();
    expect(calls[0].raw).toContain(`token=${row.unsub_token}`);
  });

  it('a throwing transport is counted as failed and the research row stays complete', async () => {
    const rid = generateId();
    await seed(rid, [{ email: 'boom@example.test', confirmedAt: 100 }]);
    const { transport } = recordingTransport('throw');
    const result = await notifySubscribersForResearch(mailEnv(transport), { researchId: rid, query: 'q', slug: `slug-${rid}` });
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(0);

    const research = await env.DB.prepare('SELECT status FROM research WHERE id = ?1').bind(rid).first();
    expect(research.status).toBe('complete');
    const row = await env.DB.prepare("SELECT last_notified_at FROM subscribers WHERE email = 'boom@example.test'").first();
    expect(row.last_notified_at).toBe(null); // stays eligible for the next run
  });

  it('does nothing when mail is not configured', async () => {
    const rid = generateId();
    await seed(rid, [{ email: 'quiet@example.test', confirmedAt: 100 }]);
    const result = await notifySubscribersForResearch(env, { researchId: rid, query: 'q', slug: `slug-${rid}` });
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0, reason: 'not-configured' });
  });

  it('needs both a research id and a slug', async () => {
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    expect((await notifySubscribersForResearch(mail, { researchId: null, query: 'q', slug: 's' })).reason).toBe('no-target');
    expect((await notifySubscribersForResearch(mail, { researchId: 'r', query: 'q', slug: '' })).reason).toBe('no-target');
    expect(calls).toHaveLength(0);
  });

  it('batches notifications and defers overflow rows without updating last_notified_at', async () => {
    const rid = generateId();
    const subscribers = Array.from({ length: 30 }, (_, i) => ({
      email: `sub${i}@example.test`,
      confirmedAt: 100,
    }));
    await seed(rid, subscribers);
    const { calls, transport } = recordingTransport();
    const result = await notifySubscribersForResearch(mailEnv(transport), { researchId: rid, query: 'best laptops', slug: `slug-${rid}` });

    expect(result.sent).toBe(25);
    expect(result.deferred).toBe(5);
    expect(calls).toHaveLength(25);

    const notified = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE research_id = ?1 AND last_notified_at IS NOT NULL").bind(rid).first();
    expect(notified.n).toBe(25);

    const deferred = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE research_id = ?1 AND last_notified_at IS NULL").bind(rid).first();
    expect(deferred.n).toBe(5);
  });
});

describe('unsubscribe receipt', () => {
  it('removes every row for the address and sends one receipt', async () => {
    const rid = generateId();
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    await handleSubscribe(postJson({ email: 'bye@example.test', researchId: rid }, '10.0.0.8'), mail);
    const row = await env.DB.prepare("SELECT unsub_token FROM subscribers WHERE email = 'bye@example.test'").first();

    const res = await handleUnsubscribe(new Request(`https://x/unsubscribe?token=${row.unsub_token}`, { method: 'POST' }), mail);
    expect(res.status).toBe(200);
    const active = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE email = 'bye@example.test' AND unsubscribed_at IS NULL").first();
    expect(active.n).toBe(0);

    const receipts = calls.filter((c) => c.raw.includes('You are unsubscribed from Frank'));
    expect(receipts).toHaveLength(1);
    expect(receipts[0].to).toBe('bye@example.test');
    expect(receipts[0].raw).not.toContain('List-Unsubscribe');
  });

  it('a repeat click changes nothing and sends no second receipt', async () => {
    const rid = generateId();
    const { calls, transport } = recordingTransport();
    const mail = mailEnv(transport);
    await handleSubscribe(postJson({ email: 'twice@example.test', researchId: rid }, '10.0.0.9'), mail);
    const row = await env.DB.prepare("SELECT unsub_token FROM subscribers WHERE email = 'twice@example.test'").first();
    const link = new Request(`https://x/unsubscribe?token=${row.unsub_token}`, { method: 'POST' });
    await handleUnsubscribe(link, mail);
    await handleUnsubscribe(new Request(`https://x/unsubscribe?token=${row.unsub_token}`, { method: 'POST' }), mail);
    expect(calls.filter((c) => c.raw.includes('You are unsubscribed')).length).toBe(1);
  });
});

describe('mailer gates', () => {
  it('the raw harness env can never send: no secrets, no stub, no throw', async () => {
    expect(mailConfigured(env)).toBe(false);
    const result = await sendMail(env, { to: 'nobody@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('disabled'); // vitest.config.js forces MAIL_ENABLED = "false"
  });

  it('skips with not-configured when the switch is on but the secrets are missing', async () => {
    // The stub is still attached, so even this path cannot open a socket.
    const { calls, transport } = recordingTransport();
    const noSecrets = { ...mailEnv(transport), TRUERANK_RESEND_API_KEY: '' };
    const result = await sendMail(noSecrets, { to: 'nobody@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result).toEqual({ ok: false, skipped: 'not-configured' });
    expect(calls).toHaveLength(0);
  });

  it('is fail-closed: an ABSENT MAIL_ENABLED skips, it does not send', async () => {
    const { calls, transport } = recordingTransport();
    const { MAIL_ENABLED, ...noFlag } = mailEnv(transport);
    const result = await sendMail(noFlag, { to: 'nobody@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result).toEqual({ ok: false, skipped: 'disabled' });
    expect(mailConfigured(noFlag)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('the pool blanks the Resend key, so the real transport is unreachable', async () => {
    expect(env.TRUERANK_RESEND_API_KEY || '').toBe('');
    expect(env.MAIL_ENABLED).toBe('false');
  });

  it('stops at the daily cap and never calls the transport', async () => {
    const { calls, transport } = recordingTransport();
    const mail = { ...mailEnv(transport), MAIL_DAILY_CAP: '2' };
    await env.KV.put(dailyCounterKey(Date.now()), '2');
    const result = await sendMail(mail, { to: 'capped@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result).toEqual({ ok: false, skipped: 'daily-cap' });
    expect(calls).toHaveLength(0);
  });

  it('counts a successful send against the daily cap', async () => {
    const { transport } = recordingTransport();
    const mail = mailEnv(transport);
    await sendMail(mail, { to: 'counted@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(Number(await env.KV.get(dailyCounterKey(Date.now())))).toBe(1);
  });

  it('returns an error object instead of throwing when the transport fails', async () => {
    const { transport } = recordingTransport('throw');
    const result = await sendMail(mailEnv(transport), { to: 'fail@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('resend refused');
  });

  it('returns an error instead of throwing when the message cannot be built', async () => {
    const { calls, transport } = recordingTransport();
    const result = await sendMail(mailEnv(transport), { to: 'not-an-address', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('hands the transport the key and a Resend payload from Frank', async () => {
    const { calls, transport } = recordingTransport();
    const seen = [];
    const spy = async (cfg, payload) => { seen.push(cfg.apiKey); return transport(cfg, payload); };
    await sendMail({ ...mailEnv(spy) }, { to: 'shape@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(seen).toEqual(['test-only-value']);
    expect(calls[0].payload.from).toBe('Frank <chris@chrisputer.tech>');
    expect(calls[0].payload.to).toEqual(['shape@example.test']);
  });
});

describe('default transport (no stub)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts to the Resend API with a Bearer key and counts the send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    const { __mailTransport, ...live } = mailEnv(async () => ({}));
    const result = await sendMail(live, { to: 'live@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result).toEqual({ ok: true, response: 'msg_1' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer test-only-value');
    expect(JSON.parse(init.body).to).toEqual(['live@example.test']);
    expect(Number(await env.KV.get(dailyCounterKey(Date.now())))).toBe(1);
  });

  it('a Resend refusal becomes an error result and is not counted', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ message: 'Domain not verified' }), { status: 403 }));
    const { __mailTransport, ...live } = mailEnv(async () => ({}));
    const result = await sendMail(live, { to: 'live@example.test', subject: 's', text: 't', html: '<p>h</p>' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Domain not verified');
    expect(await env.KV.get(dailyCounterKey(Date.now()))).toBe(null);
  });
});
