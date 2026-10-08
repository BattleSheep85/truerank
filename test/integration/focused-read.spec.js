import { describe, it, expect } from 'vitest';
import { readFocusedPage } from '../../worker/engine/verify-resolve.js';

// Regression (2026-10-08): the focused claim-page read always ran keyless, so
// heavy retailer pages timed out on Jina's free tier (Target: 641 chars inside
// Frank vs 6002 with a keyed read). With a key it must send it.
function recordingFetch(body = 'x'.repeat(2000)) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    return new Response(body, { status: 200 });
  };
  return { calls, fetchImpl };
}

describe('readFocusedPage', () => {
  it('sends the Jina key when one is given', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const text = await readFocusedPage('https://www.target.com/p/example/-/A-1', fetchImpl, 'test-key');
    expect(text.length).toBe(2000);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBe('Bearer test-key');
    expect(calls[0].headers['X-Remove-Selector']).toContain('nav');
  });

  it('reads keyless when no key is given', async () => {
    const { calls, fetchImpl } = recordingFetch();
    await readFocusedPage('https://www.target.com/p/example/-/A-1', fetchImpl);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('returns an empty string on an HTTP error and never throws', async () => {
    const fetchImpl = async () => new Response('no', { status: 402 });
    await expect(readFocusedPage('https://www.target.com/p/example/-/A-1', fetchImpl, 'k')).resolves.toBe('');
  });
});
