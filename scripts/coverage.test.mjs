// node:test harness so Node's built-in V8 coverage (zero npm) can measure the
// pure test suites. Run:
//   node --test --experimental-test-coverage \
//     --test-coverage-include='worker/lib/**' --test-coverage-include='worker/engine/**' \
//     scripts/coverage.test.mjs
// Each suite is a hand-rolled runner returning {passed, failed, failures}; we
// just assert zero failures so coverage reflects what the suites exercise.
import test from 'node:test';
import assert from 'node:assert';

import { runCredibilityTests } from '../test/unit/credibility.test.js';
import { runValidateTests } from '../test/unit/validate.test.js';
import { runProductSearchTests } from '../test/unit/product-search.test.js';
import { runReviewsRenderTests } from '../test/unit/reviews.test.js';
import { runCredibilityExtraTests } from '../test/unit/credibility-extra.test.js';
import { runPromptsTests } from '../test/unit/prompts.test.js';
import { runLlmTests } from '../test/unit/llm.test.js';
import { runUtilsTests } from '../test/unit/utils.test.js';
import { runAffiliateLinksTests } from '../test/unit/affiliate-links.test.js';
import { runLibPureTests } from '../test/unit/lib-pure.test.js';
import { runBurstGateTests } from '../test/unit/burst-gate.test.js';
import { runAffiliateGateTests } from '../test/unit/affiliate-gate.test.js';
import { runLlmJsonTests } from '../test/unit/llm-json.test.js';
import { runPoolTests } from '../test/unit/pool.test.js';
import { runEmailMimeTests } from '../test/unit/email-mime.test.js';
import { runSmtpTests } from '../test/unit/smtp.test.js';
import { runEmailTemplatesTests } from '../test/unit/email-templates.test.js';
import { runSubscribeFlowTests } from '../test/unit/subscribe-flow.test.js';
import { runListableTests } from '../test/unit/listable.test.js';
import { runGroundingCheckTests } from '../benchmarks/tests/grounding-check.test.mjs';
import { runProductLinkUnitTests } from '../test/unit/product-link.test.js';
import { runVerifyResolveTests } from '../test/unit/verify-resolve.test.js';

const suites = [
  ['credibility', runCredibilityTests],
  ['validate-quality-gate', runValidateTests],
  ['product-search', runProductSearchTests],
  ['reviews-render', runReviewsRenderTests],
  ['utils', runUtilsTests],
  ['affiliate-links', runAffiliateLinksTests],
  ['lib-pure', runLibPureTests],
  ['product-link', runProductLinkUnitTests],
  ['verify-resolve', runVerifyResolveTests],
  ['credibility-extra', runCredibilityExtraTests],
  ['prompts', runPromptsTests],
  ['llm', runLlmTests],
  ['burst-gate', runBurstGateTests],
  ['affiliate-gate', runAffiliateGateTests],
  ['llm-json', runLlmJsonTests],
  ['pool', runPoolTests],
  ['email-mime', runEmailMimeTests],
  ['smtp', runSmtpTests],
  ['email-templates', runEmailTemplatesTests],
  ['subscribe-flow', runSubscribeFlowTests],
  ['listable', runListableTests],
  ['grounding-check', runGroundingCheckTests],
];

for (const [name, fn] of suites) {
  test(name, async () => {
    const report = await fn();
    assert.strictEqual(report.failed, 0, `${name}: ${report.failures.join('; ')}`);
  });
}
