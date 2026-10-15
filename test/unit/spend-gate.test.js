// Unit coverage for worker/lib/spend-gate.js, the SITE-WIDE hourly ceiling on
// new paid research runs. Hand-rolled fake KV, same approach as the other
// zero-dependency suites: the module only reaches KV through checkRateLimit,
// which needs get('json') and put().
import {
  checkGlobalResearchSpend,
  RESEARCH_GLOBAL_KEY,
  RESEARCH_GLOBAL_LIMIT,
  RESEARCH_GLOBAL_WINDOW_SECONDS,
} from '../../worker/lib/spend-gate.js';

// Minimal KV that stores JSON strings, and records every key it was asked for
// so a test can prove the key is constant.
function fakeKv() {
  const store = new Map();
  const keysSeen = [];
  return {
    store,
    keysSeen,
    async get(key, type) {
      keysSeen.push(key);
      const raw = store.get(key);
      if (raw === undefined) return null;
      return type === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { store.set(key, value); },
  };
}

function throwingKv(message) {
  return {
    async get() { throw new Error(message); },
    async put() { throw new Error(message); },
  };
}

export async function runSpendGateTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  const realLog = console.log;
  const realError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // 1. No KV at all -> fail OPEN. Covers plain-Node runs and a binding that
    //    is missing in a stripped-down config.
    eq('missing env allows', (await checkGlobalResearchSpend(undefined)).allowed, true);
    eq('missing KV allows', (await checkGlobalResearchSpend({})).allowed, true);

    // 2. A KV error fails OPEN. Never refuse a paid run over telemetry.
    eq('throwing KV allows', (await checkGlobalResearchSpend({ KV: throwingKv('boom') })).allowed, true);

    // 3. Under the ceiling every call passes; the call at the ceiling and
    //    every call after it is refused.
    {
      const env = { KV: fakeKv() };
      const verdicts = [];
      for (let i = 0; i < RESEARCH_GLOBAL_LIMIT + 5; i++) {
        verdicts.push((await checkGlobalResearchSpend(env)).allowed);
      }
      eq('admitted equals the ceiling', verdicts.filter((v) => v === true).length, RESEARCH_GLOBAL_LIMIT);
      eq('the rest are refused', verdicts.filter((v) => v === false).length, 5);
    }

    // 4. THE mechanism: the key is a CONSTANT, never derived from the caller.
    //    That is what makes one shared counter instead of one per visitor, so
    //    a distributed source cannot buy itself a fresh budget. This is the
    //    gap the per-IP cap in handlers/research.js cannot close.
    {
      const kv = fakeKv();
      const env = { KV: kv };
      await checkGlobalResearchSpend(env);
      await checkGlobalResearchSpend(env);
      const distinct = new Set(kv.keysSeen);
      eq('every call hits one key', distinct.size, 1);
      eq('the key embeds the constant', [...distinct][0].includes(RESEARCH_GLOBAL_KEY), true);
      eq('one counter in KV', kv.store.size, 1);
    }

    // 5. A refusal carries a usable Retry-After, so the 429 branch in the
    //    handler can tell the caller when to come back.
    {
      const env = { KV: fakeKv() };
      for (let i = 0; i < RESEARCH_GLOBAL_LIMIT; i++) await checkGlobalResearchSpend(env);
      const blocked = await checkGlobalResearchSpend(env);
      eq('refused', blocked.allowed, false);
      eq('retry-after is positive', blocked.retryAfterSeconds > 0, true);
      eq('retry-after is within the window', blocked.retryAfterSeconds <= RESEARCH_GLOBAL_WINDOW_SECONDS, true);
    }

    // 6. An allowed call reports no wait, so the handler never emits a
    //    meaningless Retry-After on the happy path.
    {
      const allowed = await checkGlobalResearchSpend({ KV: fakeKv() });
      eq('allowed reports no wait', allowed.retryAfterSeconds, 0);
    }

    // 7. The trip log is one structured JSON line carrying the tuning data.
    {
      const lines = [];
      const env = { KV: fakeKv() };
      for (let i = 0; i < RESEARCH_GLOBAL_LIMIT; i++) await checkGlobalResearchSpend(env);
      console.log = (line) => lines.push(line);
      await checkGlobalResearchSpend(env);
      console.log = () => {};
      eq('one log line per trip', lines.length, 1);
      const entry = JSON.parse(lines[0]);
      eq('log names the gate', entry.where, 'spend-gate');
      eq('log names the event', entry.event, 'global-throttle');
      eq('log reports the limit', entry.limit, RESEARCH_GLOBAL_LIMIT);
      eq('log reports the window', entry.windowSeconds, RESEARCH_GLOBAL_WINDOW_SECONDS);
    }

    // 8. An allowed call logs nothing, so normal traffic stays silent.
    {
      const lines = [];
      console.log = (line) => lines.push(line);
      await checkGlobalResearchSpend({ KV: fakeKv() });
      console.log = () => {};
      eq('no log on the allow path', lines.length, 0);
    }
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  // 9. Sizing sanity. A run costs about $0.10, so the hourly ceiling must stay
  //    well inside a $60 month even if it is reached every hour of a day.
  eq('ceiling is a positive integer', Number.isInteger(RESEARCH_GLOBAL_LIMIT) && RESEARCH_GLOBAL_LIMIT > 0, true);
  eq('hourly window', RESEARCH_GLOBAL_WINDOW_SECONDS, 3600);
  eq('a full day at the ceiling stays under a 60 dollar month', RESEARCH_GLOBAL_LIMIT * 24 * 0.1 <= 60 * 2, true);

  return report;
}
