// Assertions for worker/lib/connection-gate.js: a run's searches and page
// reads take one of a few connection slots, so a fetch's timer starts only
// when the fetch can really open its connection.
import {
  createConnectionGate,
  gated,
  withConnectionGate,
  VERIFY_CONNECTION_SLOTS,
} from '../../worker/lib/connection-gate.js';

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function runConnectionGateTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  ok('verify slots leave room under the 6-connection Worker cap', VERIFY_CONNECTION_SLOTS >= 1 && VERIFY_CONNECTION_SLOTS < 6);

  // At most `slots` tasks run at once, and every task runs.
  {
    const gate = createConnectionGate(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const task = (v) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
      return v;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((v) => gate.run(task(v))));
    eq('gate: all tasks give their value', results, [1, 2, 3, 4, 5]);
    eq('gate: never more than 2 at once', maxInFlight, 2);
    eq('gate: no slot held after the burst', gate.active(), 0);
    eq('gate: nobody waits after the burst', gate.waiting(), 0);
  }

  // Waiters start in arrival order.
  {
    const gate = createConnectionGate(1);
    const order = [];
    await Promise.all(['a', 'b', 'c'].map((v) => gate.run(async () => {
      order.push(v);
      await delay(1);
    })));
    eq('gate: first come, first served', order, ['a', 'b', 'c']);
  }

  // A task does not start (its timer would not run) until a slot is free.
  {
    const gate = createConnectionGate(1);
    let release;
    const first = gate.run(() => new Promise((r) => { release = r; }));
    let secondStarted = false;
    const second = gate.run(async () => { secondStarted = true; return 'second'; });
    await delay(5);
    eq('gate: the second task waits while the slot is held', secondStarted, false);
    eq('gate: one task waits', gate.waiting(), 1);
    release('first');
    eq('gate: first value', await first, 'first');
    eq('gate: second runs once the slot frees', await second, 'second');
  }

  // A thrown task frees its slot and the error reaches the caller.
  {
    const gate = createConnectionGate(1);
    let err = null;
    try {
      await gate.run(async () => { throw new Error('boom'); });
    } catch (e) {
      err = e;
    }
    eq('gate: task error reaches the caller', err?.message, 'boom');
    eq('gate: a failed task frees its slot', await gate.run(async () => 'next'), 'next');
    eq('gate: no slot held after a failure', gate.active(), 0);
  }

  // A synchronous throw also frees the slot.
  {
    const gate = createConnectionGate(1);
    let err = null;
    try {
      await gate.run(() => { throw new Error('sync'); });
    } catch (e) {
      err = e;
    }
    eq('gate: sync throw reaches the caller', err?.message, 'sync');
    eq('gate: sync throw frees the slot', gate.active(), 0);
  }

  // A waiter whose signal aborts leaves the line and never runs.
  {
    const gate = createConnectionGate(1);
    let release;
    const first = gate.run(() => new Promise((r) => { release = r; }));
    const stop = new AbortController();
    let ran = false;
    const waiter = gate.run(async () => { ran = true; }, stop.signal);
    stop.abort(new Error('deadline'));
    let err = null;
    try {
      await waiter;
    } catch (e) {
      err = e;
    }
    eq('gate: an aborted waiter rejects with the abort reason', err?.message, 'deadline');
    eq('gate: an aborted waiter leaves the line', gate.waiting(), 0);
    release();
    await first;
    eq('gate: an aborted waiter never runs', ran, false);
    eq('gate: slot is free after an aborted waiter', gate.active(), 0);
  }

  // An already-aborted signal never takes a slot.
  {
    const gate = createConnectionGate(1);
    const stop = new AbortController();
    stop.abort(new Error('already'));
    let err = null;
    try {
      await gate.run(async () => 'x', stop.signal);
    } catch (e) {
      err = e;
    }
    eq('gate: already-aborted signal rejects', err?.message, 'already');
    eq('gate: already-aborted signal takes no slot', gate.active(), 0);
  }

  // A signal that aborts after the task got its slot is the task's business.
  {
    const gate = createConnectionGate(1);
    const stop = new AbortController();
    const result = gate.run(async () => {
      stop.abort();
      return 'kept';
    }, stop.signal);
    eq('gate: abort after start does not cancel the task', await result, 'kept');
  }

  // Bad slot counts fall back to one slot.
  {
    for (const bad of [0, -2, 1.5, 'x', undefined]) {
      const gate = createConnectionGate(bad);
      let inFlight = 0;
      let maxInFlight = 0;
      await Promise.all([1, 2, 3].map(() => gate.run(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(1);
        inFlight--;
      })));
      eq(`gate: slots ${String(bad)} → 1`, maxInFlight, 1);
    }
  }

  // gated(): with no gate the task runs at once; with a gate it waits its turn.
  {
    eq('gated: no gate runs the task', await gated(null, undefined, async () => 'direct'), 'direct');
    const gate = createConnectionGate(1);
    eq('gated: with a gate runs the task', await gated(gate, undefined, async () => 'via gate'), 'via gate');
    eq('gated: a non-gate object is ignored', await gated({}, undefined, async () => 'plain'), 'plain');
  }

  // withConnectionGate(): a copy of env with a fresh gate; env is not changed.
  {
    const env = { KV: { name: 'kv' }, JINA_API_KEY: 'k' };
    const runEnv = withConnectionGate(env);
    ok('withConnectionGate: returns a copy', runEnv !== env);
    eq('withConnectionGate: env not changed', Object.keys(env).sort(), ['JINA_API_KEY', 'KV']);
    ok('withConnectionGate: bindings kept', runEnv.KV === env.KV && runEnv.JINA_API_KEY === 'k');
    ok('withConnectionGate: a gate is set', typeof runEnv.connectionGate?.run === 'function');
    ok('withConnectionGate: each run gets its own gate', withConnectionGate(env).connectionGate !== runEnv.connectionGate);
    ok('withConnectionGate: an existing gate is kept', withConnectionGate(runEnv) === runEnv);
    ok('withConnectionGate: no env still gets a gate', typeof withConnectionGate(undefined).connectionGate?.run === 'function');
  }

  return report;
}
