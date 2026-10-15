// Workers integration-test harness (Miniflare-backed, via @cloudflare/vitest-plugin).
// Runs tests INSIDE workerd with real local D1 + KV bindings read from
// wrangler.toml, so handlers / db / KV-backed logic can be exercised the way the
// deployed worker runs them. DEV-ONLY — never ships to the worker.
//
// The fast pure-logic suites stay on `node scripts/run-tests.mjs` (zero-dep);
// these integration specs live under test/integration/ and run via `npx vitest`.
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      // Inherit bindings (DB, KV, vars, compatibility_date) from the real
      // wrangler config; Miniflare provides in-memory local D1/KV for tests
      // so nothing touches production.
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        // HARD GUARD: the wrangler config also loads .dev.vars, which on a
        // developer machine holds the real mailbox credentials. Blank them
        // for the whole pool so no spec can ever open a socket to the mail
        // server, even if it forgets the env.__mailTransport stub.
        bindings: {
          MAIL_ENABLED: 'false',
          TRUERANK_SMTP_USER: '',
          TRUERANK_SMTP_PASSWORD: '',
          // Fixed test salt: worker/lib/ip-hash.js fails closed without one,
          // and .dev.vars (gitignored) is not on CI or a fresh checkout.
          IP_HASH_SALT: 'integration-test-salt',
        },
      },
    }),
  ],
  test: {
    include: ['test/integration/**/*.spec.js'],
    // Vitest 5 turns this on by default, but @cloudflare/vitest-plugin 1.4.2
    // cannot read the cached modules inside workerd (every spec fails with
    // "no such file or directory, readAll node_modules/.vitest-cache/...").
    fsModuleCache: false,
    coverage: {
      provider: 'istanbul', // v8 coverage doesn't work inside workerd; istanbul does
      reporter: ['text', 'text-summary'],
      include: [
        'worker/lib/db.js', 'worker/lib/rate-limit.js', 'worker/lib/sitemap.js',
        'worker/handlers/affiliate.js', 'worker/handlers/report.js', 'worker/handlers/internal.js',
        'worker/lib/classifier.js', 'worker/lib/indexnow.js',
        'worker/lib/asin-resolver.js', 'worker/lib/image-resolver.js',
        'worker/lib/youtube.js', 'worker/lib/jina.js', 'worker/lib/duckduckgo.js', 'worker/lib/rss.js',
        'worker/engine/parallel-engine.js',
        'worker/pages/browse.js', 'worker/pages/category.js', 'worker/pages/research-page.js',
        'worker/handlers/subscribe.js', 'worker/handlers/image.js', 'worker/handlers/auth.js',
        'worker/index.js',
      ],
    },
  },
});
