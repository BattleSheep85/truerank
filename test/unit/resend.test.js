// Unit coverage for worker/lib/resend.js. Every send case injects a fake
// fetch, so NO request ever leaves the machine and no test can send mail.
// The sharp edges: header injection (a CR or LF must throw, never be cleaned)
// and the API key, which must never appear in an error message.
import {
  buildResendPayload, sendViaResend, ResendError, isValidEmailAddress, RESEND_ENDPOINT, retryDelayMs,
} from '../../worker/lib/resend.js';

const KEY = 're_not_a_real_key_123';

const MESSAGE = {
  from: 'chris@chrisputer.tech',
  fromName: 'Frank',
  to: 'reader@example.com',
  subject: 'Your Frank report is ready',
  text: 'Plain body.',
  html: '<p>HTML body.</p>',
};

// A fake fetch that records each call and answers with a scripted response.
function fakeFetch(status, body) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
  return { calls, impl };
}

// A fake fetch that never answers until the abort signal fires.
const hangingFetch = (url, init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

export async function runResendTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const ok = (name, cond) => {
    if (cond) report.passed++; else { report.failed++; report.failures.push(`${name}: expected truthy`); }
  };
  const eq = (name, a, e) => {
    const same = JSON.stringify(a) === JSON.stringify(e);
    if (same) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
  };
  const throws = (name, fn) => {
    try { fn(); report.failed++; report.failures.push(`${name}: expected a throw`); } catch { report.passed++; }
  };
  const rejects = async (name, promise, check = () => true) => {
    try { await promise; report.failed++; report.failures.push(`${name}: expected a rejection`); } catch (err) {
      if (check(err)) report.passed++; else { report.failed++; report.failures.push(`${name}: wrong error ${err?.message}`); }
    }
  };

  // 1. Payload shape: the fields the Resend send API takes.
  {
    const p = buildResendPayload({ ...MESSAGE, extraHeaders: { 'List-Unsubscribe': '<https://x/u?t=1>' } });
    eq('from carries the display name', p.from, 'Frank <chris@chrisputer.tech>');
    eq('to is a one-item list', p.to, ['reader@example.com']);
    eq('subject passes through', p.subject, MESSAGE.subject);
    eq('text passes through', p.text, MESSAGE.text);
    eq('html passes through', p.html, MESSAGE.html);
    eq('auto-submitted header always set', p.headers['Auto-Submitted'], 'auto-generated');
    eq('extra header passes through', p.headers['List-Unsubscribe'], '<https://x/u?t=1>');
  }

  // 2. A display name with a quote or comma is quoted; no name means a bare address.
  {
    eq('quoted display name', buildResendPayload({ ...MESSAGE, fromName: 'Chris, "Frank"' }).from, '"Chris, \\"Frank\\"" <chris@chrisputer.tech>');
    eq('no display name', buildResendPayload({ ...MESSAGE, fromName: '' }).from, 'chris@chrisputer.tech');
  }

  // 3. Header injection: CR or LF anywhere in a header throws.
  {
    throws('CRLF in subject', () => buildResendPayload({ ...MESSAGE, subject: 'Hi\r\nBcc: x@y.z' }));
    throws('LF in subject', () => buildResendPayload({ ...MESSAGE, subject: 'Hi\nthere' }));
    throws('CR in display name', () => buildResendPayload({ ...MESSAGE, fromName: 'A\rB' }));
    throws('LF in extra header value', () => buildResendPayload({ ...MESSAGE, extraHeaders: { 'X-A': 'a\nb' } }));
    throws('LF in extra header name', () => buildResendPayload({ ...MESSAGE, extraHeaders: { 'X-A\nBcc': 'a' } }));
  }

  // 4. Addresses are checked before anything is sent.
  {
    throws('bad to', () => buildResendPayload({ ...MESSAGE, to: 'not-an-address' }));
    throws('bad from', () => buildResendPayload({ ...MESSAGE, from: 'nobody' }));
    eq('valid address accepted', isValidEmailAddress('a.b+c@sub.example.co.uk'), true);
    eq('spaces rejected', isValidEmailAddress('a b@example.com'), false);
    eq('over-long address rejected', isValidEmailAddress(`${'a'.repeat(250)}@example.com`), false);
    eq('non-string rejected', isValidEmailAddress(null), false);
  }

  // 5. Happy path: one POST to the documented endpoint with a Bearer key.
  {
    const { calls, impl } = fakeFetch(200, { id: 'msg_123' });
    const payload = buildResendPayload(MESSAGE);
    const result = await sendViaResend({ apiKey: KEY }, payload, impl);
    eq('one request', calls.length, 1);
    eq('endpoint', calls[0].url, 'https://api.resend.com/emails');
    eq('endpoint constant', RESEND_ENDPOINT, 'https://api.resend.com/emails');
    eq('method', calls[0].init.method, 'POST');
    eq('auth header', calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    eq('json content type', calls[0].init.headers['Content-Type'], 'application/json');
    eq('body is the payload', JSON.parse(calls[0].init.body), payload);
    ok('request carries an abort signal', calls[0].init.signal instanceof AbortSignal);
    eq('result carries the message id', result, { ok: true, response: 'msg_123' });
  }

  // 6. An API refusal throws ResendError with the status and Resend's reason,
  //    and never the key.
  {
    const { impl } = fakeFetch(422, { statusCode: 422, name: 'validation_error', message: 'The domain is not verified.' });
    await rejects('422 refusal', sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), impl), (err) =>
      err instanceof ResendError && err.status === 422 && err.message.includes('The domain is not verified.') && !err.message.includes(KEY));
    const { impl: html } = fakeFetch(502, '<html>bad gateway</html>');
    await rejects('non-JSON error body', sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), html), (err) =>
      err instanceof ResendError && err.status === 502 && err.message.includes('HTTP 502'));
    const { impl: keyEcho } = fakeFetch(401, { message: `API key ${KEY} is invalid` });
    await rejects('key echoed by the API is redacted', sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), keyEcho), (err) =>
      err.status === 401 && !err.message.includes(KEY));
  }

  // 7. A 200 without an id still counts as sent; the response is just empty.
  {
    const { impl } = fakeFetch(200, 'not json');
    eq('200 without id', await sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), impl), { ok: true, response: '' });
  }

  // 8. No key, no request.
  {
    const { calls, impl } = fakeFetch(200, { id: 'x' });
    await rejects('missing key', sendViaResend({ apiKey: '' }, buildResendPayload(MESSAGE), impl), (err) => err instanceof ResendError);
    eq('no request without a key', calls.length, 0);
  }

  // 9. A hung request is cut off by the deadline and never hangs the caller.
  {
    await rejects('timeout', sendViaResend({ apiKey: KEY, timeoutMs: 20 }, buildResendPayload(MESSAGE), hangingFetch), (err) =>
      err instanceof ResendError && /timed out/i.test(err.message));
  }

  // 10. A network failure is wrapped without the key.
  {
    const boom = async () => { throw new TypeError('fetch failed'); };
    await rejects('network error', sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), boom), (err) =>
      err instanceof ResendError && err.message.includes('fetch failed') && !err.message.includes(KEY));
  }

  // 11. A 429 is retried once after Retry-After; a second 429 gives up.
  {
    const answers = [
      new Response('{"message":"Too many requests"}', { status: 429, headers: { 'retry-after': '1' } }),
      new Response('{"id":"msg_retry"}', { status: 200 }),
    ];
    const waits = [];
    let n = 0;
    const impl = async () => answers[n++];
    const result = await sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), impl, async (ms) => { waits.push(ms); });
    eq('retried 429 succeeds', result, { ok: true, response: 'msg_retry' });
    eq('two requests', n, 2);
    eq('waited Retry-After', waits, [1000]);

    let m = 0;
    const always429 = async () => { m++; return new Response('{"message":"Too many requests"}', { status: 429 }); };
    await rejects('second 429 gives up', sendViaResend({ apiKey: KEY }, buildResendPayload(MESSAGE), always429, async () => {}), (err) =>
      err.status === 429);
    eq('only one retry', m, 2);
  }

  // 12. Retry-After is bounded: missing or junk means 1 s, large means 2 s.
  {
    const r = (h) => new Response('', { status: 429, headers: h });
    eq('no header', retryDelayMs(r({})), 1000);
    eq('junk header', retryDelayMs(r({ 'retry-after': 'soon' })), 1000);
    eq('capped', retryDelayMs(r({ 'retry-after': '60' })), 2000);
    eq('fraction', retryDelayMs(r({ 'retry-after': '0.5' })), 500);
  }

  return report;
}
