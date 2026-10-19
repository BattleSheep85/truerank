#!/usr/bin/env node
// Manual one-off deliverability smoke. NEVER runs in CI and never ships to the
// worker. It reuses the real worker/lib/resend.js payload builder and sender,
// so the code under test is the deployed one.
//
// Usage:
//   bws-exec TRUERANK_RESEND_API_KEY -- node scripts/send-test-email.mjs --to chris@chrisputer.tech
//
// The key comes from the environment only (bws-exec), never from .dev.vars:
// `wrangler dev` reads .dev.vars and runs with MAIL_ENABLED = "true", so a key
// there would make a local dev server send real mail. It is never printed.
// After the message arrives, open it and check the Authentication-Results
// header for `spf=pass` and `dkim=pass` with `header.d=chrisputer.tech`.
// That proves the whole chain once.
import { buildResendPayload, sendViaResend } from '../worker/lib/resend.js';

const FROM = process.env.MAIL_FROM || 'chris@chrisputer.tech';

async function main() {
    const toIndex = process.argv.indexOf('--to');
    const to = toIndex > -1 ? process.argv[toIndex + 1] : '';
    if (!to) {
        console.error('Usage: node scripts/send-test-email.mjs --to <address>');
        process.exit(2);
    }
    const apiKey = process.env.TRUERANK_RESEND_API_KEY || '';
    if (!apiKey) {
        console.error('Missing TRUERANK_RESEND_API_KEY. Run it under bws-exec TRUERANK_RESEND_API_KEY --.');
        process.exit(2);
    }

    const payload = buildResendPayload({
        from: FROM,
        fromName: 'Frank',
        to,
        subject: 'Frank mail path check',
        text: 'This is a one-off check of the Frank mail path. No action is needed.\n',
        html: '<p>This is a one-off check of the Frank mail path. No action is needed.</p>',
    });
    const result = await sendViaResend({ apiKey }, payload);
    console.log(JSON.stringify({ where: 'send-test-email', provider: 'resend', response: result.response }));
}

main().catch((err) => {
    console.error(JSON.stringify({ where: 'send-test-email', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
});
