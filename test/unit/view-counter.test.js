// Unit coverage for worker/lib/view-counter.js, the sampled view counter that
// replaced one D1 write per page view. Zero dependencies: the increment policy
// is pure and takes its random roll as an argument, and the D1 side is a
// hand-rolled fake that records the statements it was handed.
import {
  viewIncrement,
  recordView,
  parsePageMeta,
  buildPageMeta,
  COUNT_EXACTLY_BELOW,
  SAMPLE_RATE,
} from '../../worker/lib/view-counter.js';

// Minimal D1 that records every prepare/bind/run it saw.
function fakeDb() {
  const runs = [];
  return {
    runs,
    prepare(sql) {
      return {
        bind(...args) {
          return { async run() { runs.push({ sql, args }); return { success: true }; } };
        },
      };
    },
  };
}

function throwingDb(message) {
  return {
    prepare() {
      return {
        bind() {
          return { async run() { throw new Error(message); } };
        },
      };
    },
  };
}

export async function runViewCounterTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };

  // 1. Below the threshold every view writes exactly 1, whatever the roll is.
  //    New and long-tail pages keep exact counts, so small numbers and the
  //    ordering that depends on them stay truthful.
  eq('zero views counts exactly', viewIncrement(0, 0.99), 1);
  eq('mid-range counts exactly', viewIncrement(COUNT_EXACTLY_BELOW - 1, 0.99), 1);
  eq('a null count is treated as zero', viewIncrement(null, 0.99), 1);
  eq('an undefined count is treated as zero', viewIncrement(undefined, 0.5), 1);
  eq('a non-numeric count is treated as zero', viewIncrement('many', 0.9), 1);

  // 2. At and above the threshold the write is sampled: a winning roll writes
  //    SAMPLE_RATE, a losing roll writes nothing.
  eq('at the threshold a winning roll writes the batch', viewIncrement(COUNT_EXACTLY_BELOW, 0), SAMPLE_RATE);
  eq('at the threshold a losing roll skips', viewIncrement(COUNT_EXACTLY_BELOW, 0.99), 0);
  eq('a hot page with a winning roll writes the batch', viewIncrement(50000, 0.0001), SAMPLE_RATE);
  eq('a hot page with a losing roll skips', viewIncrement(50000, 0.5), 0);

  // 3. THE invariant that makes sampling safe: expected value is still 1 per
  //    view, so ORDER BY view_count keeps ranking the same pages in the same
  //    order. Sum the policy across the whole roll space at 1/SAMPLE_RATE
  //    granularity and check it equals the view count.
  {
    const views = SAMPLE_RATE * 100;
    let total = 0;
    for (let i = 0; i < views; i++) total += viewIncrement(10000, (i % SAMPLE_RATE) / SAMPLE_RATE);
    eq('sampled total equals the real view count', total, views);
  }

  // 4. The write rate above the threshold really does drop by SAMPLE_RATE.
  {
    const views = SAMPLE_RATE * 100;
    let writes = 0;
    for (let i = 0; i < views; i++) if (viewIncrement(10000, (i % SAMPLE_RATE) / SAMPLE_RATE) > 0) writes++;
    eq('one write per sample batch', writes, views / SAMPLE_RATE);
  }

  // 5. recordView by id writes the delta, not a hardcoded 1.
  {
    const db = fakeDb();
    await recordView(db, { id: 'r1', view_count: 0 });
    eq('one statement', db.runs.length, 1);
    eq('updates by id', db.runs[0].sql.includes('WHERE id = ?2'), true);
    eq('binds the delta first', db.runs[0].args[0], 1);
    eq('binds the id second', db.runs[0].args[1], 'r1');
  }

  // 6. recordView by slug (the KV cache-hit path, which knows no id) keeps the
  //    status guard so a failed or in-flight row can never gain views.
  {
    const db = fakeDb();
    await recordView(db, { slug: 'best-thing-abcd1234', view_count: 0 });
    eq('one statement', db.runs.length, 1);
    eq('updates by slug', db.runs[0].sql.includes('WHERE slug = ?2'), true);
    eq('keeps the complete-only guard', db.runs[0].sql.includes("status = 'complete'"), true);
    eq('binds the slug', db.runs[0].args[1], 'best-thing-abcd1234');
  }

  // 7. A skipped sample issues NO statement at all. This is the whole point:
  //    the saving is the absent D1 round trip, not a cheaper one.
  {
    const db = fakeDb();
    let skipped = 0;
    for (let i = 0; i < 400; i++) {
      const before = db.runs.length;
      await recordView(db, { id: 'hot', view_count: 100000 });
      if (db.runs.length === before) skipped++;
    }
    eq('most hot-page views issue no statement', skipped > 0, true);
    eq('hot-page writes are far below the view count', db.runs.length < 400, true);
  }

  // 8. Bad input and D1 failures never throw. A view counter must not be able
  //    to break a page render.
  {
    eq('no db is a no-op', await recordView(null, { id: 'r1' }), undefined);
    eq('no entry is a no-op', await recordView(fakeDb(), null), undefined);
    const db = fakeDb();
    await recordView(db, { view_count: 0 });
    eq('an entry with neither id nor slug writes nothing', db.runs.length, 0);
    const realError = console.error;
    console.error = () => {};
    try {
      eq('a D1 failure is swallowed', await recordView(throwingDb('d1 down'), { id: 'r1', view_count: 0 }), undefined);
    } finally {
      console.error = realError;
    }
  }

  // 9. Cache meta round-trips both fields.
  {
    const parsed = parsePageMeta(buildPageMeta(1750000000, 4321));
    eq('lastModified round-trips', parsed.lastModified, 1750000000);
    eq('viewCount round-trips', parsed.viewCount, 4321);
  }

  // 10. Legacy bare-integer meta values still parse. A deploy must not lose
  //     Last-Modified on pages already in KV, and an unknown view count must
  //     fall back to counting exactly, which is the safe direction.
  {
    const legacy = parsePageMeta('1750000000');
    eq('legacy lastModified survives', legacy.lastModified, 1750000000);
    eq('legacy count is unknown, so count exactly', legacy.viewCount, 0);
    eq('an unknown count counts exactly', viewIncrement(legacy.viewCount, 0.99), 1);
  }

  // 11. Missing and malformed meta degrade instead of throwing.
  {
    eq('null meta', parsePageMeta(null), { lastModified: undefined, viewCount: 0 });
    eq('empty meta', parsePageMeta(''), { lastModified: undefined, viewCount: 0 });
    eq('garbage meta', parsePageMeta('not json'), { lastModified: undefined, viewCount: 0 });
    eq('partial meta keeps what it can', parsePageMeta('{"lm":123}'), { lastModified: 123, viewCount: 0 });
    eq('a missing view count builds as zero', parsePageMeta(buildPageMeta(123, undefined)).viewCount, 0);
  }

  return report;
}
