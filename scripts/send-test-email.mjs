#!/usr/bin/env node
// Manual one-off deliverability smoke. NEVER runs in CI and never ships to the
// worker. It reuses the real worker/lib/smtp.js dialogue over a node:tls socket
// so the protocol under test is the deployed one.
//
// Usage:
//   node scripts/send-test-email.mjs --to chris@chrisputer.tech
//
// Credentials come from the environment, or from .dev.vars when the variables
// are not already set. They are never printed. After the message arrives, open
// it and check the Authentication-Results header for `spf=pass` and `dkim=pass`
// with `header.d=chrisputer.tech`. That proves the whole chain once.
import { connect } from 'node:tls';
import { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildMimeMessage } from '../worker/lib/mime.js';
import { createIo, sendViaSmtp } from '../worker/lib/smtp.js';

const HOST = process.env.SMTP_HOST || 'smtp.hostinger.com';
const PORT = Number(process.env.SMTP_PORT || 465);
const CONNECT_TIMEOUT_MS = 20_000;

/** Read one key out of .dev.vars without printing anything. */
function fromDevVars(name) {
    try {
        const root = dirname(dirname(fileURLToPath(import.meta.url)));
        const line = readFileSync(join(root, '.dev.vars'), 'utf8')
            .split('\n')
            .find((l) => l.startsWith(`${name}=`));
        return line ? line.slice(name.length + 1).trim() : '';
    } catch {
        return '';
    }
}

const secret = (name) => process.env[name] || fromDevVars(name);

/** Open a TLS socket and adapt it to the io contract smtp.js expects. */
function openNodeSocket(host, port) {
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port, servername: host }, () => {
            const { readable, writable } = Duplex.toWeb(socket);
            resolve(createIo({ readable, writable, close: async () => socket.destroy() }));
        });
        socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy(new Error('TLS connect timed out.')));
        socket.once('error', reject);
    });
}

async function main() {
    const toIndex = process.argv.indexOf('--to');
    const to = toIndex > -1 ? process.argv[toIndex + 1] : '';
    if (!to) {
        console.error('Usage: node scripts/send-test-email.mjs --to <address>');
        process.exit(2);
    }
    const username = secret('TRUERANK_SMTP_USER');
    const password = secret('TRUERANK_SMTP_PASSWORD');
    if (!username || !password) {
        console.error('Missing TRUERANK_SMTP_USER or TRUERANK_SMTP_PASSWORD. Set them in the environment or .dev.vars.');
        process.exit(2);
    }

    const raw = buildMimeMessage({
        from: username,
        fromName: 'Chris at Frank',
        to,
        subject: 'Frank mail path check',
        text: 'This is a one-off check of the Frank mail path. No action is needed.\n',
        html: '<p>This is a one-off check of the Frank mail path. No action is needed.</p>',
    });

    const result = await sendViaSmtp({
        host: HOST,
        port: PORT,
        username,
        password,
        from: username,
        to,
        heloDomain: username.slice(username.indexOf('@') + 1),
    }, raw, openNodeSocket);
    console.log(JSON.stringify({ where: 'send-test-email', host: HOST, port: PORT, response: result.response }));
}

main().catch((err) => {
    console.error(JSON.stringify({ where: 'send-test-email', error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
});
