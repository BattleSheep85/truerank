// Stage deadlines for the verify path (Truth Audit). A stage gets an
// AbortSignal that fires at its deadline. Reads stop at that time, keep the
// text that arrived, and the stage goes on with what it has.
//
// Zero runtime deps. Timers are injectable, so tests use a fake clock.

// After a stage signal aborts, runPoolUntil waits at most this long for the
// started thunks to settle. Reads stop on the abort, so this only bounds a
// thunk that ignores the signal.
export const POOL_GRACE_MS = 1000;

/** The abort reason of a stage deadline. */
export class DeadlineError extends Error {
  constructor(ms) {
    super(`stage deadline of ${ms} ms reached`);
    this.name = 'DeadlineError';
  }
}

/** A promise with its resolve function: { promise, resolve }. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Calls fn once, when signal aborts (now, if it already has). Returns a
// function that removes the listener.
function onAbort(signal, fn) {
  if (!signal) return () => {};
  if (signal.aborted) {
    fn();
    return () => {};
  }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}

/**
 * A signal that aborts when any given signal aborts (null and undefined
 * entries are skipped). Returns undefined when no signal is given.
 */
export function anySignal(signals) {
  const list = (Array.isArray(signals) ? signals : []).filter(Boolean);
  if (list.length <= 1) return list[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const s of list) onAbort(s, () => controller.abort(s.reason));
  return controller.signal;
}

/**
 * A stage signal: aborts ms after this call, or when `parent` aborts.
 * Returns { signal, cancel }. cancel() stops the timer: call it when the
 * stage ends before its deadline.
 */
export function deadlineSignal(ms, { parent, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const timer = setTimer(() => abort(new DeadlineError(ms)), Math.max(0, ms));
  const stopParent = onAbort(parent, () => abort(parent.reason));
  const cancel = () => {
    clearTimer(timer);
    stopParent();
  };
  return { signal: controller.signal, cancel };
}

/** A timer: { promise, cancel }. promise resolves ms after this call. */
export function delay(ms, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  const promise = new Promise((resolve) => {
    timer = setTimer(resolve, Math.max(0, ms));
  });
  return { promise, cancel: () => clearTimer(timer) };
}

/**
 * { promise, cancel }: promise resolves graceMs after `signal` aborts, and
 * never without a signal. cancel() frees the listener and the timer.
 */
export function afterAbort(signal, graceMs, setTimer = setTimeout, clearTimer = clearTimeout) {
  let timer = null;
  let stopListening = () => {};
  const promise = new Promise((resolve) => {
    stopListening = onAbort(signal, () => {
      timer = setTimer(resolve, Math.max(0, graceMs));
    });
  });
  const cancel = () => {
    stopListening();
    if (timer !== null) clearTimer(timer);
  };
  return { promise, cancel };
}

/**
 * runPool with a stop signal: at most `limit` thunks at once, results in
 * input order. A thunk that has not started when `signal` aborts never
 * starts. Resolves when every started thunk has settled, or graceMs after
 * the abort, whichever comes first. A slot without a result (not started,
 * or still running at that time) holds onMissing(index). A thunk that throws
 * gives onError(err, index). Later results of a running thunk are ignored.
 */
export async function runPoolUntil(thunks, limit, opts = {}) {
  const {
    signal,
    graceMs = POOL_GRACE_MS,
    onError = () => undefined,
    onMissing = () => undefined,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = opts;
  const list = Array.isArray(thunks) ? thunks : [];
  const results = new Array(list.length);
  const settled = new Array(list.length).fill(false);
  let next = 0;

  const lane = async () => {
    while (next < list.length && !signal?.aborted) {
      const index = next;
      next += 1;
      try {
        results[index] = await list[index]();
      } catch (err) {
        results[index] = onError(err, index);
      }
      settled[index] = true;
    }
  };

  const laneCount = Math.max(1, Math.min(limit, list.length));
  const lanes = Promise.all(Array.from({ length: laneCount }, lane));
  const stop = afterAbort(signal, graceMs, setTimer, clearTimer);
  try {
    await Promise.race([lanes, stop.promise]);
  } finally {
    stop.cancel();
  }
  // Array.from, not results.map: map skips the holes of slots never filled.
  return Array.from({ length: list.length }, (_, index) => (settled[index] ? results[index] : onMissing(index)));
}

/**
 * A hedged call: calls start() once, and once more when the first call has
 * not settled after hedgeAfterMs (0 = never). Resolves with the first call
 * that succeeds. A first call that fails before the second one starts
 * rejects at once (the hedge is not a retry); after both started, it rejects
 * with the first error only when both failed. onHedge() runs when the second
 * call starts. The slower call is not stopped: its result is dropped.
 */
export function hedged(start, hedgeAfterMs, { setTimer = setTimeout, clearTimer = clearTimeout, onHedge } = {}) {
  return new Promise((resolve, reject) => {
    let started = 0;
    let failures = 0;
    let firstError = null;
    let settled = false;
    let timer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimer(timer);
      settle(value);
    };
    const launch = () => {
      started += 1;
      Promise.resolve()
        .then(start)
        .then(
          (value) => finish(resolve, value),
          (err) => {
            failures += 1;
            if (firstError === null) firstError = err;
            if (failures === started) finish(reject, firstError);
          },
        );
    };
    launch();
    if (hedgeAfterMs > 0) {
      timer = setTimer(() => {
        timer = null;
        if (settled) return;
        onHedge?.();
        launch();
      }, hedgeAfterMs);
    }
  });
}
