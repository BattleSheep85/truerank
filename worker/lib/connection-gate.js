// Connection slots for one product check (CP-718 round 3).
//
// A Cloudflare Worker invocation keeps about 6 connections open at once. A
// fetch past that waits in the runtime's queue, but its timeout timer runs
// from the fetch() call. The verify check started up to 24 searches and 16
// page reads at once, so many reads spent their 8 s waiting in that queue and
// timed out without ever reaching the site (127 timeouts in 7 live runs).
// Repeat runs then read different pages and scored differently.
//
// With a gate, a search or page read first takes a slot, and only then opens
// its connection and starts its timer. Zero runtime deps.

// Slots of a verify check: under the Worker's 6, so an LLM call (not gated)
// still finds a free connection.
export const VERIFY_CONNECTION_SLOTS = 5;

/**
 * A gate with `slots` connection slots (1 when slots is not a positive
 * integer). run(fn, signal) waits for a free slot, first come first served,
 * then calls fn and frees the slot when fn settles; it gives fn's value or
 * error. When `signal` aborts while the task waits, the task leaves the line
 * without running and run rejects with the abort reason. active() and
 * waiting() count the held slots and the waiting tasks.
 */
export function createConnectionGate(slots) {
  const limit = Number.isInteger(slots) && slots > 0 ? slots : 1;
  let active = 0;
  const line = [];

  const release = () => {
    const next = line.shift();
    if (next) next.start();
    else active -= 1;
  };

  const acquire = (signal) => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < limit) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const at = line.indexOf(entry);
        if (at >= 0) line.splice(at, 1);
        reject(signal.reason);
      };
      const entry = {
        start: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      line.push(entry);
    });
  };

  const run = async (fn, signal) => {
    await acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return { run, active: () => active, waiting: () => line.length };
}

/** fn() through `gate` when it is a gate, else fn() at once. */
export function gated(gate, signal, fn) {
  return typeof gate?.run === 'function' ? gate.run(fn, signal) : fn();
}

/**
 * A copy of `env` with a fresh gate of VERIFY_CONNECTION_SLOTS as
 * `connectionGate`, or env itself when it already has one. The searches and
 * page reads of one check share it (worker/engine/tools.js, worker/lib/jina.js,
 * worker/engine/verify-resolve.js). Does not change env.
 */
export function withConnectionGate(env) {
  if (typeof env?.connectionGate?.run === 'function') return env;
  return { ...(env ?? {}), connectionGate: createConnectionGate(VERIFY_CONNECTION_SLOTS) };
}
