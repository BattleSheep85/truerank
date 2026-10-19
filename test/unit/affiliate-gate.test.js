// Unit coverage for worker/lib/affiliate-gate.js, the SITE-WIDE affiliate
// throttle added after the 2026-08-15 IP-rotating click incident.
// Hand-rolled fake limiters, same approach as test/unit/burst-gate.test.js:
// the module only ever calls limiter.limit({ key }) and reads .success.
import { readFileSync } from 'node:fs';
import {
  isAffiliateFloodActive,
  AFFILIATE_GLOBAL_KEY,
  AFFILIATE_GLOBAL_LIMIT,
  AFFILIATE_GLOBAL_PERIOD_SECONDS,
  isAffiliateHourlyCapHit,
  affiliateHourlyLimit,
  AFFILIATE_HOURLY_KEY,
  AFFILIATE_HOURLY_WINDOW_SECONDS,
  DEFAULT_AFFILIATE_HOURLY_LIMIT,
} from '../../worker/lib/affiliate-gate.js';

// In-memory KV with the two calls the sliding-window limiter makes.
function fakeKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) { store.set(key, value); },
  };
}

function throwingKv() {
  return { async get() { throw new Error('kv down'); }, async put() { throw new Error('kv down'); } };
}

// Read one [vars] value out of a wrangler config.
function tomlVar(path, name) {
  const toml = readFileSync(new URL(path, import.meta.url), 'utf8');
  const m = toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'));
  return m ? m[1] : null;
}

// A limiter with a fixed answer that records every call it saw.
function fakeLimiter(success) {
  const calls = [];
  return { calls, async limit(opts) { calls.push(opts); return { success }; } };
}

// A limiter with the real binding's counting behaviour: the first `limit`
// calls per unique key succeed, the rest fail. No clock, so one window.
function countingLimiter(limit) {
  const seen = new Map();
  return {
    seen,
    async limit({ key }) {
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      return { success: n <= limit };
    },
  };
}

function throwingLimiter(message) {
  return { async limit() { throw new Error(message); } };
}

// Read the binding block out of the deployed config so the exported constants
// cannot drift away from what actually ships.
function ratelimitBlock(path, name) {
  const toml = readFileSync(new URL(path, import.meta.url), 'utf8');
  const start = toml.indexOf(`name = "${name}"`);
  if (start < 0) return null;
  const block = toml.slice(start, start + 200);
  const limit = block.match(/limit\s*=\s*(\d+)/);
  const period = block.match(/period\s*=\s*(\d+)/);
  return { limit: limit && Number(limit[1]), period: period && Number(period[1]) };
}

export async function runAffiliateGateTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // Swallow the trip log so a passing run stays readable. Restored below.
  const realLog = console.log;
  console.log = () => {};
  try {
    // 1. No binding at all -> fail OPEN. Covers plain-Node runs and a
    //    config-only rollback that deletes the [[ratelimits]] block.
    eq('missing env is not a flood', await isAffiliateFloodActive(undefined), false);
    eq('missing binding is not a flood', await isAffiliateFloodActive({}), false);

    // 2. Under the limit -> not a flood. Over -> flood.
    eq('binding says success -> no flood', await isAffiliateFloodActive({ RL_AFFILIATE_GLOBAL: fakeLimiter(true) }), false);
    eq('binding says blocked -> flood', await isAffiliateFloodActive({ RL_AFFILIATE_GLOBAL: fakeLimiter(false) }), true);

    // 3. A binding error fails OPEN. Never break the redirect over telemetry.
    eq('throwing binding is not a flood', await isAffiliateFloodActive({ RL_AFFILIATE_GLOBAL: throwingLimiter('boom') }), false);

    // 4. THE mechanism: the key is a CONSTANT, never derived from the caller.
    //    That is what makes one shared counter instead of one per visitor, so
    //    rotating the source address cannot buy a fresh budget.
    {
      const limiter = fakeLimiter(true);
      const env = { RL_AFFILIATE_GLOBAL: limiter };
      await isAffiliateFloodActive(env);
      await isAffiliateFloodActive(env);
      eq('one token per call', limiter.calls.length, 2);
      eq('first call uses the constant key', limiter.calls[0], { key: AFFILIATE_GLOBAL_KEY });
      eq('second call uses the same key', limiter.calls[1], { key: AFFILIATE_GLOBAL_KEY });
    }

    // 5. Rotating-IP evasion, at the gate level: 40 calls that share nothing
    //    but the site itself still land on one counter, so exactly the limit
    //    gets through and everything after it is flagged.
    {
      const limiter = countingLimiter(AFFILIATE_GLOBAL_LIMIT);
      const env = { RL_AFFILIATE_GLOBAL: limiter };
      const flags = [];
      for (let i = 0; i < 40; i++) flags.push(await isAffiliateFloodActive(env));
      eq('admitted equals the configured limit', flags.filter((f) => f === false).length, AFFILIATE_GLOBAL_LIMIT);
      eq('the rest are flagged', flags.filter((f) => f === true).length, 40 - AFFILIATE_GLOBAL_LIMIT);
      eq('all 40 hit one counter', limiter.seen.size, 1);
    }

    // 6. The trip log is one structured JSON line carrying the tuning data.
    {
      const lines = [];
      console.log = (line) => lines.push(line);
      await isAffiliateFloodActive({ RL_AFFILIATE_GLOBAL: fakeLimiter(false) });
      console.log = () => {};
      eq('one log line per trip', lines.length, 1);
      const entry = JSON.parse(lines[0]);
      eq('log names the gate', entry.where, 'affiliate-gate');
      eq('log names the event', entry.event, 'global-throttle');
      eq('log reports the limit', entry.limit, AFFILIATE_GLOBAL_LIMIT);
      eq('log reports the period', entry.periodSeconds, AFFILIATE_GLOBAL_PERIOD_SECONDS);
    }

    // 7. An allowed call logs nothing, so normal traffic stays silent.
    {
      const lines = [];
      console.log = (line) => lines.push(line);
      await isAffiliateFloodActive({ RL_AFFILIATE_GLOBAL: fakeLimiter(true) });
      console.log = () => {};
      eq('no log on the allow path', lines.length, 0);
    }
  } finally {
    console.log = realLog;
  }

  // 8. The constants match the shipped bindings. Both configs, because
  //    ratelimits are not inherited between wrangler configs.
  const prod = ratelimitBlock('../../wrangler.toml', 'RL_AFFILIATE_GLOBAL');
  eq('prod binding exists', prod !== null, true);
  eq('prod limit matches the constant', prod && prod.limit, AFFILIATE_GLOBAL_LIMIT);
  eq('prod period matches the constant', prod && prod.period, AFFILIATE_GLOBAL_PERIOD_SECONDS);
  const dev = ratelimitBlock('../../wrangler.dev.toml', 'RL_AFFILIATE_GLOBAL');
  eq('dev binding exists', dev !== null, true);
  eq('dev limit matches the constant', dev && dev.limit, AFFILIATE_GLOBAL_LIMIT);
  eq('dev period matches the constant', dev && dev.period, AFFILIATE_GLOBAL_PERIOD_SECONDS);

  // 9. The native binding only accepts a 10 s or 60 s window.
  eq('period is a supported window', [10, 60].includes(AFFILIATE_GLOBAL_PERIOD_SECONDS), true);

  // ── Hourly site-wide counter (CP-353): the slow, wide shape ──────────────
  // A source that stays under 6 a minute never trips the native gate, so a
  // KV sliding window bounds the hour.
  console.log = () => {};
  const realError = console.error;
  console.error = () => {};
  try {
    // 10. The limit comes from config, with a safe default.
    eq('limit from env var', affiliateHourlyLimit({ AFFILIATE_GLOBAL_HOURLY_LIMIT: '12' }), 12);
    eq('missing var -> default', affiliateHourlyLimit({}), DEFAULT_AFFILIATE_HOURLY_LIMIT);
    eq('missing env -> default', affiliateHourlyLimit(undefined), DEFAULT_AFFILIATE_HOURLY_LIMIT);
    eq('junk var -> default', affiliateHourlyLimit({ AFFILIATE_GLOBAL_HOURLY_LIMIT: 'lots' }), DEFAULT_AFFILIATE_HOURLY_LIMIT);
    eq('zero var -> default', affiliateHourlyLimit({ AFFILIATE_GLOBAL_HOURLY_LIMIT: '0' }), DEFAULT_AFFILIATE_HOURLY_LIMIT);
    eq('negative var -> default', affiliateHourlyLimit({ AFFILIATE_GLOBAL_HOURLY_LIMIT: '-5' }), DEFAULT_AFFILIATE_HOURLY_LIMIT);
    eq('window is one hour', AFFILIATE_HOURLY_WINDOW_SECONDS, 3600);

    // 11. Fail OPEN without KV or on a KV error.
    eq('no env -> not capped', await isAffiliateHourlyCapHit(undefined), false);
    eq('no KV -> not capped', await isAffiliateHourlyCapHit({}), false);
    eq('KV error -> not capped', await isAffiliateHourlyCapHit({ KV: throwingKv() }), false);

    // 12. Exactly N per hour pass, all on one constant key.
    {
      const kv = fakeKv();
      const env = { KV: kv, AFFILIATE_GLOBAL_HOURLY_LIMIT: '5' };
      const flags = [];
      for (let i = 0; i < 12; i++) flags.push(await isAffiliateHourlyCapHit(env));
      eq('hourly: admitted equals the configured limit', flags.filter((f) => f === false).length, 5);
      eq('hourly: the rest are capped', flags.filter((f) => f === true).length, 7);
      eq('hourly: one counter', kv.store.size, 1);
      eq('hourly: constant key', [...kv.store.keys()][0], `ratelimit:${AFFILIATE_HOURLY_KEY}`);
    }

    // 13. One structured trip line, silent on the allow path.
    {
      const lines = [];
      console.log = (line) => lines.push(line);
      const env = { KV: fakeKv(), AFFILIATE_GLOBAL_HOURLY_LIMIT: '1' };
      await isAffiliateHourlyCapHit(env);
      eq('hourly: no log on allow', lines.length, 0);
      await isAffiliateHourlyCapHit(env);
      console.log = () => {};
      eq('hourly: one log line per trip', lines.length, 1);
      const entry = JSON.parse(lines[0]);
      eq('hourly log names the gate', entry.where, 'affiliate-gate');
      eq('hourly log names the event', entry.event, 'global-hourly-throttle');
      eq('hourly log reports the limit', entry.limit, 1);
      eq('hourly log reports the window', entry.windowSeconds, 3600);
    }
  } finally {
    console.log = realLog;
    console.error = realError;
  }

  // 14. N lives in config, in both wrangler files, and parses to a real limit.
  for (const path of ['../../wrangler.toml', '../../wrangler.dev.toml']) {
    const raw = tomlVar(path, 'AFFILIATE_GLOBAL_HOURLY_LIMIT');
    eq(`${path} sets AFFILIATE_GLOBAL_HOURLY_LIMIT`, raw !== null, true);
    eq(`${path} hourly limit is a positive integer`, /^[1-9]\d*$/.test(raw || ''), true);
  }

  return report;
}
