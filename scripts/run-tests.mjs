#!/usr/bin/env node
// Test runner for the worker's in-repo test suites. Zero dependencies —
// run with plain `node scripts/run-tests.mjs`. Exits non-zero on any failure
// so it can gate commits or deploys.
//
// This is THE way the credibility rubric (PRD §2 trust-weight table) is
// re-verified. If you touch worker/lib/credibility.js, run this.

import { runCredibilityTests } from '../test/unit/credibility.test.js';
import { runValidateTests } from '../test/unit/validate.test.js';
import { runProductSearchTests } from '../test/unit/product-search.test.js';
import { runReviewsRenderTests } from '../test/unit/reviews.test.js';
import { runBrowseRenderTests } from '../test/unit/browse.test.js';
import { runPagerTests } from '../test/unit/pager.test.js';
import { runListableTests } from '../test/unit/listable.test.js';
import { runCredibilityExtraTests } from '../test/unit/credibility-extra.test.js';
import { runPromptsTests } from '../test/unit/prompts.test.js';
import { runLlmTests } from '../test/unit/llm.test.js';
import { runUtilsTests } from '../test/unit/utils.test.js';
import { runResearchPrimitivesTests } from '../test/unit/research-primitives.test.js';
import { runAffiliateLinksTests } from '../test/unit/affiliate-links.test.js';
import { runLibPureTests } from '../test/unit/lib-pure.test.js';
import { runAsinResolverTests } from '../test/unit/asin-resolver.test.js';
import { runVerdictTests } from '../test/unit/verdict.test.js';
import { runVerifyTests } from '../test/unit/verify.test.js';
import { runVerificationRenderTests } from '../test/unit/verification-render.test.js';
import { runJinaTests } from '../test/unit/jina.test.js';
import { runSearxngTests } from '../test/unit/searxng.test.js';
import { runIpHashTests } from '../test/unit/ip-hash.test.js';
import { runQuotaTests } from '../test/unit/quota.test.js';
import { runConstraintsTests } from '../test/unit/constraints.test.js';
import { runBurstGateTests } from '../test/unit/burst-gate.test.js';
import { runAffiliateGateTests } from '../test/unit/affiliate-gate.test.js';
import { runLlmJsonTests } from '../test/unit/llm-json.test.js';
import { runPoolTests } from '../test/unit/pool.test.js';
import { runOpeningBookTests } from '../test/unit/opening-book.test.js';
import { runRecallGatherTests } from '../test/unit/recall-gather.test.js';
import { runEmailMimeTests } from '../test/unit/email-mime.test.js';
import { runSmtpTests } from '../test/unit/smtp.test.js';
import { runEmailTemplatesTests } from '../test/unit/email-templates.test.js';
import { runSubscribeFlowTests } from '../test/unit/subscribe-flow.test.js';
import { runDeadUrlsTests } from '../test/unit/dead-urls.test.js';
import { runResearchCanonicalTests } from '../test/unit/research-canonical.test.js';
import { runWorkerAuthTests } from '../test/unit/worker-auth.test.js';
import { runGroundingCheckTests } from '../benchmarks/tests/grounding-check.test.mjs';
import { runNoAnthropicOnOpenRouterTests } from '../benchmarks/tests/no-anthropic-on-openrouter.test.mjs';
import { runClaudeCodeJudgeTests } from '../benchmarks/tests/claude-code-judge.test.mjs';
import { runUrlGuardTests } from '../test/unit/url-guard.test.js';
import { runSafetyTests } from '../test/unit/safety.test.js';
import { runSpendGateTests } from '../test/unit/spend-gate.test.js';
import { runViewCounterTests } from '../test/unit/view-counter.test.js';
import { runConsentTests } from '../test/unit/consent.test.js';

const suites = [
  ['consent', runConsentTests],
  ['credibility', runCredibilityTests],
  ['validate-quality-gate', runValidateTests],
  ['product-search', runProductSearchTests],
  ['reviews-render', runReviewsRenderTests], // async suite (awaited below)
  ['browse-render', runBrowseRenderTests], // async suite (awaited below)
  ['pager', runPagerTests],
  ['listable', runListableTests],
  ['utils', runUtilsTests],
  ['research-primitives', runResearchPrimitivesTests],
  ['affiliate-links', runAffiliateLinksTests],
  ['lib-pure', runLibPureTests],
  ['credibility-extra', runCredibilityExtraTests],
  ['prompts', runPromptsTests],
  ['llm', runLlmTests],
  ['asin-resolver', runAsinResolverTests],
  ['verdict', runVerdictTests],
  ['verify', runVerifyTests],
  ['verification-render', runVerificationRenderTests],
  ['jina', runJinaTests], // async suite (awaited below)
  ['searxng', runSearxngTests], // async suite (awaited below)
  ['ip-hash', runIpHashTests], // async suite (awaited below)
  ['quota', runQuotaTests], // async suite (awaited below)
  ['constraints', runConstraintsTests],
  ['burst-gate', runBurstGateTests], // async suite (awaited below)
  ['affiliate-gate', runAffiliateGateTests], // async suite (awaited below)
  ['llm-json', runLlmJsonTests],
  ['pool', runPoolTests], // async suite (awaited below)
  ['opening-book', runOpeningBookTests], // async suite (awaited below)
  ['recall-gather', runRecallGatherTests], // async suite (awaited below)
  ['email-mime', runEmailMimeTests],
  ['smtp', runSmtpTests], // async suite (awaited below)
  ['email-templates', runEmailTemplatesTests],
  ['subscribe-flow', runSubscribeFlowTests],
  ['dead-urls', runDeadUrlsTests],
  ['research-canonical', runResearchCanonicalTests], // async suite (awaited below)
  ['worker-auth', runWorkerAuthTests], // async suite (awaited below)
  // Benchmark-side, but gated here on purpose: this suite is the guard against
  // shipping another broken grounding measurement (docs/benchmark-validity-audit.md).
  ['grounding-check', runGroundingCheckTests],
  ['no-anthropic-on-openrouter', runNoAnthropicOnOpenRouterTests],
  ['claude-code-judge', runClaudeCodeJudgeTests],
  ['url-guard', runUrlGuardTests],
  ['safety', runSafetyTests],
  ['spend-gate', runSpendGateTests],
  ['view-counter', runViewCounterTests],
];

let failed = 0;
for (const [name, fn] of suites) {
  const report = await fn();
  const total = report.passed + report.failed;
  console.log(`${name}: ${report.passed}/${total} passed`);
  if (report.failed > 0) {
    failed += report.failed;
    for (const f of report.failures) console.log(`  FAIL ${f}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll suites green');
