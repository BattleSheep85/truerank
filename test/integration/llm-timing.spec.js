// callLLM's onTiming hook (CP-789): how long a call waited for the response
// headers and how long it took in total. fetch is stubbed: no network.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLLM } from '../../worker/engine/llm.js';

afterEach(() => vi.unstubAllGlobals());

const reply = { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { cost: 0.001 } };

describe('callLLM onTiming', () => {
  it('reports the wait for headers and the total time', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify(reply), { status: 200 });
    }));
    const seen = [];
    const res = await callLLM('sk-or-test', 'm', [{ role: 'user', content: 'hi' }], { onTiming: (t) => seen.push(t) });
    expect(res.choices[0].message.content).toBe('ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].headersMs).toBeGreaterThanOrEqual(25);
    expect(seen[0].totalMs).toBeGreaterThanOrEqual(seen[0].headersMs);
  });

  it('a throwing onTiming does not break the call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(reply), { status: 200 })));
    const res = await callLLM('sk-or-test', 'm', [{ role: 'user', content: 'hi' }], { onTiming: () => { throw new Error('log broke'); } });
    expect(res.choices[0].message.content).toBe('ok');
  });

  it('onTiming is not sent to the provider', async () => {
    const bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify(reply), { status: 200 }); }));
    await callLLM('sk-or-test', 'm', [{ role: 'user', content: 'hi' }], { onTiming: () => {} });
    expect('onTiming' in bodies[0]).toBe(false);
  });
});
