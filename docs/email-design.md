# Email Sending Design: Subscribe, Confirm, Notify, Unsubscribe

Status: DESIGN, approved for implementation. Author: architect session, 2026-07-28.
Scope: how the zero-dependency Cloudflare Worker sends mail for the notification
list, and the full flow spec. No source file changes ship with this document.

**Update 2026-10-19 (CP-622): the transport is now Resend (option B), not SMTP.**
The SMTP client could not reach Hostinger from a deployed Worker (section 2a,
issues.md 2026-08-03). `worker/lib/smtp.js` and `worker/lib/mime.js` are gone.
`worker/lib/resend.js` posts each message to `https://api.resend.com/emails`.
The provider pick and its data are in section 3. The daily cap is now 100
(Resend free plan). Sections 4, 5.1 to 5.4, 6 and 7 are kept as the original
design record, with the current values noted where they changed.

## 1. Problem statement and design volume

The site stores notification signups (`subscribers` table) but never sends any
email. The owner has one mailbox, `chris@chrisputer.tech`, hosted at Hostinger.
The site runs on the same domain from the Cloudflare Worker. Two goals:

1. The signup and unsubscribe flows must really send mail.
2. Replies must land in that one Hostinger mailbox. Mail must come from the
   human address on the site's own domain. That is the product point.

Honest volume estimate. The list is tiny. The metrics page counts subscribers
in the low tens at most. Organic research runs are a handful per day. Flywheel
runs are machine-generated queries with no subscribers. Expected traffic:

- Confirmation emails: under 5 per day.
- Report-ready notifications: under 10 per day.
- Unsubscribe receipts: near zero.

Design point: 20 sends per day typical. Hard ceiling: 200 sends per day, 50
recipients per research completion. Everything below is sized for that, with
the escalation threshold stated in section 4.

## 2. Verified platform facts (checked 2026-07-28, not assumed)

- `cloudflare:sockets` exposes `connect(address, options)` with
  `secureTransport: "off" | "on" | "starttls"` and a `startTls()` upgrade
  method. It works inside `fetch()`, `scheduled()`, and `queue()` handlers.
  No compatibility date or flag gates it. The repo's
  `compatibility_date = "2025-01-01"` is sufficient.
- Outbound port 25 is blocked: "Workers cannot create outbound TCP connections
  on port 25". Ports 465 (implicit TLS) and 587 (STARTTLS) are not blocked.
  - **CORRECTION, 2026-08-03 (measured at the edge, not assumed).** The port
    rule is true but it was the wrong rule to check. Cloudflare also blocks
    outbound TCP from a Worker to Cloudflare's own IP ranges, and
    `smtp.hostinger.com` resolves to 172.65.255.143, inside 172.65.240.0/20,
    AS13335 CLOUDFLARENET. `mx1`/`mx2.hostinger.com` sit in the same network.
    A deployed Worker therefore cannot reach Hostinger SMTP on ANY port.
    Evidence from a gated diagnostic route on the live worker: `connect()` to
    `8.8.8.8:853` with implicit TLS opens normally, while `connect()` to
    `smtp.hostinger.com:465` and `:587` both reject in under 20 ms with
    "proxy request failed, cannot connect to the specified address", before
    any TLS handshake or SMTP greeting. `npx wrangler dev` succeeded against
    the same host because it egresses from the developer LAN, which has no
    such rule. Option A below is therefore NOT implementable on Cloudflare.
    `MAIL_ENABLED` is now "false" and the choice between option B (provider
    API over `fetch`) and option C2 (Cloudflare Email Service) is open.
- Hostinger SMTP submission: host `smtp.hostinger.com`, port 465 with SSL or
  port 587 with STARTTLS. Username is the full mailbox address.
- Hostinger send caps are real: about 500 per hour over SMTP and a rolling
  daily cap in the hundreds to low thousands, plan dependent, with anti-abuse
  burst throttling. Our 200-per-day ceiling sits far under every tier.
- Cloudflare Email Routing (the old product) is inbound only for our purpose.
  Its `send_email` binding refuses recipients outside the account's verified
  destination addresses, and enabling Email Routing takes over the zone MX
  records, which would break the Hostinger mailbox. Not viable. Confirmed.
- Cloudflare Email Service (the new product) added real outbound sending, but
  it is in public beta (April 2026), Workers Paid only, 3,000 sends per month
  included, then $0.35 per 1,000. Onboarding auto-adds an SPF TXT and DKIM TXT
  on the root domain plus a `cf-bounce` MX subdomain. The root SPF auto-add
  collides with the existing Hostinger SPF record (two SPF TXT records at one
  name is a permerror that breaks BOTH senders). Viable later, not now.
- Live DNS for `chrisputer.tech` (dig, 2026-07-28) already carries the full
  Hostinger mail set: MX to `mx1/mx2.hostinger.com`, SPF
  `v=spf1 include:_spf.mail.hostinger.com ~all`, three DKIM CNAMEs
  (`hostingermail-a/b/c._domainkey`), and `_dmarc` = `v=DMARC1; p=none`.

## 2a. Re-check of Cloudflare Email Service (checked 2026-08-03)

Re-read against the current official Cloudflare documentation, per an owner
request to try option C2 again. Findings:

1. **Status.** Still public beta. Email Sending is Workers Paid plan only.
   Email Routing (the separate, older, inbound-only product) is GA.
2. **Enabling it needs a human click. No API path exists.** Onboarding a
   domain for outbound sending is: dashboard -> Compute -> Email Service ->
   Email Sending -> "Onboard Domain" -> pick the domain -> review the DNS
   records Cloudflare proposes -> "Done". There is no REST API endpoint for
   this step. A Cloudflare API token, however broad its scopes, cannot do it.
   This is a dashboard-only action, full stop.
3. **DNS records it adds.** MX, SPF TXT, and DKIM TXT under a `cf-bounce`
   subdomain it creates, plus a `_dmarc` TXT for that subdomain. Scoping SPF to
   a subdomain rather than the root would in fact sidestep the two-SPF-records
   hazard flagged in section 6, which is better than first assumed. That
   finding does not change the disqualifier in point 2.
4. Whether onboarding could touch the root MX records was not reachable from
   the docs alone (the process is dashboard-driven and not fully documented in
   text). Given point 2 already stops this option, that question was not
   pursued further.
5. Free quota: 3,000 sends per month included, then $0.35 per 1,000, matching
   the 2026-07-28 note in section 2.

**Conclusion: unchanged.** Option C2 needs the owner to click "Onboard Domain"
in the Cloudflare dashboard. That is a human action this session cannot take
on the owner's behalf, so option C2 stays deferred. No code changed as a
result of this re-check.

## 3. Option comparison

| Criterion | A. Hand-written SMTP to Hostinger over `connect()` | B. Provider API over `fetch` (Resend / Postmark / Brevo / MailerSend) | C1. CF Email Routing | C2. CF Email Service (beta) | D. Send nothing |
|---|---|---|---|---|---|
| Deliverability | Good. SPF + DKIM + MX already live and aligned (verified). Shared Hostinger IPs are a moderate risk, offset by tiny volume and DKIM d=chrisputer.tech | Best in class (dedicated pools). Postmark strongest | N/A for outbound to strangers | Unproven new pools, beta | N/A |
| Limits vs our volume | ~500/hr SMTP cap. 25x our ceiling | Resend 3,000/mo free (100/day). Postmark 100/mo free then $15/mo. Brevo 300/day free with Brevo branding. MailerSend 3,000/mo free | Verified destinations only | 3,000/mo included on Workers Paid | Zero |
| Implementation cost | Highest: ~600 new lines (SMTP + MIME + tests), all plain JS | Lowest: one `fetch` call | Blocked | Low (binding), but beta API churn | Zero |
| Maintenance | Low after v1. SMTP is frozen tech | Vendor dashboard, key rotation, DPA | N/A | Beta breakage risk before GA | Zero |
| Failure mode when down | Sends skip and log. Site unaffected | Same | N/A | Same | Always down |
| Testability | Excellent: injected transport seam, fake socket for protocol | Excellent: mock fetch | N/A | Needs beta local support | Trivial |
| Secret exposure | Mailbox password in Worker secrets (full mailbox access, see 5.9) | Narrow API key (better blast radius) | None | None (binding) | None |
| New data processor | No. Hostinger already holds the mailbox. One privacy bullet | Yes: new processor + DPA + privacy update | No | Cloudflare already listed | No |
| DNS work | NONE. All records already published | Provider DKIM + return-path subdomain records (root SPF untouched for Resend/Postmark class) | MX takeover conflict | Root SPF merge hazard with Hostinger | None |
| Reversibility | High: transport is one module behind a seam | High | N/A | Medium (beta) | High |
| Replies land in the mailbox | Yes, natively. From = the mailbox itself | Yes via verified From + Reply-To, but envelope/bounces go to the provider | N/A | Yes | N/A |


### 3a. Option B providers compared (Researcher, CP-356, 2026-10-15)

Volume we need: about 20 sends a day, design ceiling 200 a day.

| | Resend | Postmark | Brevo | MailerSend |
|---|---|---|---|---|
| Free volume | 3,000/month, **100/day**, 3 domains, no expiry | **100/month**, no expiry | ~300/day (third-party sources, official page unreadable) | **500/month**, 1 domain, card required |
| Enough for us (20 typical, 200 ceiling per day)? | Typical yes. Ceiling no: set cap to 100 | No | Yes | No (about 16/day) |
| Cheapest paid | $20/mo, 50k | $15/mo, 10k | ~$9/mo (sources disagree) | $7/mo, 5k |
| Send call from a Worker | `POST https://api.resend.com/emails`, `Authorization: Bearer` | `POST https://api.postmarkapp.com/email`, `X-Postmark-Server-Token` | `POST https://api.brevo.com/v3/smtp/email`, `api-key` header | `POST https://api.mailersend.com/v1/email`, Bearer token (not verified on official page) |
| DNS records | DKIM TXT `resend._domainkey`, MX + SPF TXT on `send` subdomain | DKIM TXT, Return-Path CNAME `pm-bounces` (record names from third-party guides) | `brevo-code` TXT, DKIM, DMARC. May offer to replace our DMARC | SPF TXT on root, 2 DKIM CNAMEs, return-path CNAME `mta` |
| Merge with Hostinger SPF | **Not needed** (SPF lives on `send.`) | Not needed (Return-Path subdomain) | Unconfirmed | **Needed**: one root SPF with both includes |
| Manual approval before real sending | None found | Yes, manual review, under 24 h on weekdays | Unconfirmed | Yes, "Get approved", up to 48 h |
| Narrow API key | Yes: "Sending access", limited to one domain | Per-server token only | Unconfirmed | Custom access per endpoint |
| Extra risk | 100/day cap | Free tier too small | Its API "IP security" can block unknown IPs. Cloudflare Workers have changing IPs (inference) | Free tier too small, logo likely on free mails |
| Data location | Stored in US, DPA available | US, DPA with SCCs | EU (France, Germany) | EU (Belgium), DPA available |

**Pick: Resend.** Reasons, in order: (1) the root SPF stays untouched, so no
risk of the two-SPF-record failure from section 6; (2) no human approval wait;
(3) a sending-only key scoped to one domain is the smallest secret of all
options; (4) the free tier covers normal traffic. Fallback if 100/day becomes a
real limit: Resend Pro ($20/mo). Brevo is the only free option above 200/day,
but its IP blocking and logo make it second choice.

Confidence: Resend limits, API, key scoping and DNS pattern are from Resend's
docs. Postmark and MailerSend limits are from vendor pages. Brevo figures are
the majority view of third-party reviews (its official pages did not load).

Sources: https://resend.com/pricing,
https://resend.com/docs/api-reference/emails/send-email,
https://resend.com/docs/api-reference/api-keys/create-api-key,
https://resend.com/docs/knowledge-base/cloudflare,
https://resend.com/docs/dashboard/domains/regions,
https://postmarkapp.com/pricing, https://www.mailersend.com/pricing,
https://developers.brevo.com/docs/ip-security.

## 4. Recommendation

**Option A. A hand-written SMTP client over `cloudflare:sockets` `connect()`,
authenticating to `smtp.hostinger.com:465` (implicit TLS) as the mailbox.**

Reasons, in order of weight:

1. The deliverability groundwork already exists. Live DNS carries aligned SPF,
   DKIM, and MX for Hostinger today. Option A needs zero DNS changes and keeps
   ONE sending identity for the domain. Every other sending option adds a
   second identity and the SPF/DKIM coexistence work that comes with it.
2. Replies and bounces land in the one mailbox with no forwarding tricks,
   because the From, the envelope sender, and the authenticated user are all
   the same address. That is the stated product point.
3. No new data processor. Subscriber addresses already sit in D1, and the mail
   transits Hostinger, which already operates the mailbox. Privacy page needs
   one added bullet, not a new vendor relationship.
4. The stack rule is zero runtime dependencies. `connect()` is a platform
   primitive. The SMTP dialogue and MIME builder are small, frozen protocols
   that fit this codebase's hand-vendored style.
5. The secrets (`TRUERANK_SMTP_USER`, `TRUERANK_SMTP_PASSWORD`) are already
   being provisioned in Bitwarden Secrets Manager for exactly this shape.
6. Volume math: our 200-per-day ceiling is far below Hostinger's caps. The
   throttle and daily-cap governor in section 5.6 keep it that way.

The cost is real: this is the largest implementation of the options, and SMTP
has sharp edges (CRLF injection, dot-stuffing, multiline replies, timeouts).
Section 5 pins all of them down.

**Thresholds that change the decision.** Migrate the transport (one module,
section 5.3 seam) when ANY of these happens:

- Sustained volume above 150 sends per day, or a burst need above 400 per
  hour. That is Hostinger cap territory.
- Measured spam-foldering of confirmation mail at Gmail/Outlook that DMARC
  reports and header checks cannot fix. Shared-IP reputation is the one thing
  we cannot control at Hostinger.
- Cloudflare Email Service reaches GA with documented SPF coexistence for a
  domain that already sends through another provider. It is the designated
  successor: platform-native, no secrets, 3,000 per month included on the paid
  plan this project already uses. Swap = replace `smtp.js` usage inside
  `mailer.js` with `env.EMAIL.send()`, delete two secrets.

Option D (send nothing) is rejected explicitly: the signup form already
promises an email. A site whose brand is honesty must not hold a silent list.

## 5. Implementation spec

### 5.0 New and changed files

| File | Change | Est. lines |
|---|---|---|
| `worker/lib/mime.js` | NEW: pure RFC 5322/2045 message builder | ~160 |
| `worker/lib/smtp.js` | NEW: SMTP dialogue over `connect()` | ~280 |
| `worker/lib/mailer.js` | NEW: gating, config, transport seam, daily cap | ~120 |
| `worker/lib/email-templates.js` | NEW: the three messages | ~170 |
| `worker/lib/notify.js` | NEW: subscriber batch send for a research row | ~120 |
| `worker/lib/subscribe-flow.js` | NEW: pure subscribe state machine | ~90 |
| `worker/handlers/confirm.js` | NEW: GET /confirm | ~90 |
| `worker/handlers/subscribe.js` | EDIT: gates + confirmation flow | ~180 total |
| `worker/handlers/unsubscribe.js` | EDIT: send receipt after success | +15 |
| `worker/index.js` | EDIT: route GET /confirm | +4 |
| `worker/jobs.js` | EDIT: reaper purges stale unconfirmed rows | +12 |
| `worker/pipeline/orchestrator.js` | EDIT: notify hook after the `won` latch | +8 |
| `schema/013_subscribers_confirm.sql` | NEW migration | ~20 |
| `wrangler.toml` | EDIT: [vars] + secret comments | +8 |
| `public/privacy.html` | EDIT: one processor bullet | +1 |
| `test/unit/email-mime.test.js`, `test/unit/smtp.test.js`, `test/unit/email-templates.test.js`, `test/unit/subscribe-flow.test.js` | NEW suites, registered in `scripts/run-tests.mjs` | ~400 |
| `test/integration/email-flows.spec.js` | NEW: handler + notify flows on Miniflare D1 | ~250 |
| `test/integration/_schema.js` | EDIT: import migration 013 | +2 |
| `scripts/send-test-email.mjs` | NEW: manual one-off smoke over node:tls | ~80 |

All files stay under 800 lines. All functions stay under 50 lines. No mutation
of shared structures: builders return new strings/objects.

### 5.1 Config and secrets

`wrangler.toml` `[vars]` additions:

```toml
MAIL_ENABLED = "true"            # emergency off switch; "false" skips all sends
MAIL_FROM = "chris@chrisputer.tech"
MAIL_FROM_NAME = "Chris at TrueRank"
SMTP_HOST = "smtp.hostinger.com"
SMTP_PORT = "465"                # implicit TLS; v1 supports 465 only
MAIL_DAILY_CAP = "200"           # global outbound ceiling per UTC day
```

Current values (CP-622, 2026-10-19): `MAIL_ENABLED = "true"`,
`MAIL_FROM_NAME = "Frank"`, `MAIL_DAILY_CAP = "100"` (Resend free plan). The
`SMTP_HOST` and `SMTP_PORT` vars are gone. The one secret is
`TRUERANK_RESEND_API_KEY` (BWS key of the same name). The original SMTP
design follows.

Secrets (already being provisioned in BWS, set with `wrangler secret put`):

- `TRUERANK_SMTP_USER` = `chris@chrisputer.tech` (Hostinger requires the full
  address as the username, and the From address must equal it).
- `TRUERANK_SMTP_PASSWORD` = the mailbox password.

Rule: when either secret is absent, every send is a logged no-op. Local dev,
CI, and the vitest harness never have these secrets, so they can never send
real mail. See 5.3.

### 5.2 `worker/lib/mime.js` (pure, no I/O)

```js
export function buildMimeMessage({ from, fromName, to, subject, text, html, extraHeaders = {} })
// -> string: full CRLF-terminated RFC 5322 message (headers + multipart/alternative body)
export function encodeBase64(input)  // string | Uint8Array -> base64 string
```

Rules:

- Reject with a thrown `Error` any header value that contains `\r` or `\n`
  (header injection guard). Re-validate `to` against the same regex
  `subscribe.js` uses.
- Headers always emitted: `From` (`"Name" <addr>`), `To`, `Subject`, `Date`
  (RFC 5322 format, `+0000` zone), `Message-ID` (`<uuid@chrisputer.tech>`),
  `MIME-Version: 1.0`, `Auto-Submitted: auto-generated`,
  `Content-Type: multipart/alternative; boundary="..."` (boundary from
  `crypto.randomUUID()`).
- Both parts are base64 transfer-encoded (`Content-Transfer-Encoding: base64`)
  and wrapped at 76 columns. This makes every body 7-bit safe and keeps lines
  legal with no quoted-printable code.
- Encode `Subject` as RFC 2047 `=?utf-8?B?...?=` when it contains non-ASCII.
  Current templates are ASCII, but the query string is interpolated.
- `extraHeaders` carries `List-Unsubscribe` and `List-Unsubscribe-Post` when
  the caller provides them. Same injection guard applies.

### 5.3 `worker/lib/smtp.js` and the transport seam

```js
export class SmtpError extends Error {}   // fields: code (number), step (string)
export async function sendViaSmtp(cfg, rawMessage, openSocket = openCloudflareSocket)
// cfg: { host, port, username, password, from, to, heloDomain, timeoutMs = 30000 }
// -> { ok: true } or throws SmtpError / timeout Error
```

- `openCloudflareSocket(host, port)` does
  `const { connect } = await import('cloudflare:sockets')` and returns a small
  io object `{ read(), write(str), close() }` over
  `connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false })`.
  The dynamic import keeps plain-node unit runs loadable (mirror of the
  burst-gate fail-soft pattern).
- Dialogue: read 220 greeting, `EHLO heloDomain` (parse multiline `250-`
  continuation until `250 `), `AUTH PLAIN` with
  `base64("\0" + username + "\0" + password)`, `MAIL FROM:<from>`,
  `RCPT TO:<to>`, `DATA` (expect 354), dot-stuffed body
  (`\r\n.` becomes `\r\n..`), terminator `\r\n.\r\n`, expect 250, `QUIT`,
  close.
- Every read/write races a deadline (`timeoutMs` total, 10s per step) so a
  hung socket can never hang the queue consumer.
- Errors carry the SMTP code and the step name. NEVER include the AUTH
  payload or the password in any error or log.
- v1 supports implicit TLS on 465 only. STARTTLS on 587 stays a documented
  follow-up (the `secureTransport: 'starttls'` + `startTls()` path), to keep
  one code path and one test matrix. Both ports are open from Workers.

**The seam.** `mailer.js` resolves the transport as
`env.__mailTransport ?? defaultTransport` where `defaultTransport` wraps
`sendViaSmtp`. Integration tests call handlers in-process with the
`cloudflare:test` env object, so they attach a stub function at
`env.__mailTransport` and no socket ever opens. Production never sets that
key. Unit tests for `smtp.js` inject `openSocket` with a scripted fake io.

### 5.4 `worker/lib/mailer.js`

Current (CP-622): gate 2 checks `TRUERANK_RESEND_API_KEY`, step 4 builds the
JSON body with `buildResendPayload` and the seam is called as
`transport({ apiKey, to }, payload)`. The default transport is
`sendViaResend` (15 s timeout, key never in errors or logs).

```js
export function mailConfigured(env)  // -> boolean (MAIL_ENABLED !== 'false' && both secrets present)
export async function sendMail(env, { to, subject, text, html, extraHeaders })
// -> { ok: true } | { ok: false, skipped: reason } | { ok: false, error: message }
// NEVER throws.
```

Order of gates inside `sendMail`:

1. `MAIL_ENABLED === 'false'` -> `{ ok: false, skipped: 'disabled' }`.
2. Missing `TRUERANK_SMTP_USER` or `TRUERANK_SMTP_PASSWORD` ->
   `{ ok: false, skipped: 'not-configured' }` plus one `console.log`.
3. Daily cap: KV counter `mail:sent:YYYY-MM-DD` (TTL 2 days). At or above
   `MAIL_DAILY_CAP` -> `{ ok: false, skipped: 'daily-cap' }`. Increment only
   after a successful send.
4. Build via `buildMimeMessage`, send via the seam, catch everything, return
   the result object. Log a JSON line
   `{ where: 'mailer', to: <hash of address, not the address>, ok, error? }`.

### 5.5 Subscribe flow (double opt-in: YES)

**Decision: add double opt-in.** Grounds, not preference:

- Legal. GDPR Art. 7(1) requires demonstrable consent. A bare unauthenticated
  POST proves nothing about mailbox ownership. German case law (BGH I ZR
  164/09) treats unconfirmed email marketing as actionable. The site has EU
  visitors. `created_at` remains the consent timestamp, `confirmed_at` becomes
  the proof.
- Abuse. Signup is an unauthenticated POST that now triggers real mail. With
  confirmation, a stranger's victim address can receive at most the tiny,
  capped confirmation message and NEVER a notification. This is the standard
  mail-bomb mitigation, layered under the gates in 5.8.
- Deliverability. The same domain and mailbox carry the owner's personal mail.
  One spamtrap or typo address on the active list damages the reputation of
  his own correspondence. Confirmation keeps unverified addresses off the
  active list entirely.

**Migration `schema/013_subscribers_confirm.sql`:**

```sql
-- TrueRank D1 Schema - migration 013
-- Double opt-in for the notification list. Active-recipient predicate becomes:
--   unsubscribed_at IS NULL AND confirmed_at IS NOT NULL
ALTER TABLE subscribers ADD COLUMN confirm_token TEXT;
ALTER TABLE subscribers ADD COLUMN confirm_sent_at INTEGER;
ALTER TABLE subscribers ADD COLUMN confirm_send_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscribers ADD COLUMN confirmed_at INTEGER;
ALTER TABLE subscribers ADD COLUMN last_notified_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_subscribers_confirm_token ON subscribers(confirm_token);
-- Grandfather pre-mailer rows: their consent basis is documented in migration
-- 009 and nothing was ever sent to them. The list is tiny; re-permission mail
-- would itself be unsolicited.
UPDATE subscribers SET confirmed_at = created_at
 WHERE confirmed_at IS NULL AND unsubscribed_at IS NULL;
```

**Token shape and lifetime.** `confirm_token` =
`crypto.randomUUID().replace(/-/g, '')` (32 hex chars, same pattern as
`unsub_token`). The link is valid for 7 days from `confirm_sent_at`. The cron
reaper deletes rows with
`confirmed_at IS NULL AND unsubscribed_at IS NULL AND COALESCE(confirm_sent_at, created_at) < now - 30 days`
(GDPR data minimization: do not hold unverified addresses).

**Pure state machine `worker/lib/subscribe-flow.js`:**

```js
export const CONFIRM_COOLDOWN_S = 86400;      // one confirmation mail per address per day
export const CONFIRM_MAX_SENDS = 3;           // lifetime cap per address
export const CONFIRM_TTL_S = 7 * 86400;
export function decideSubscribeAction(rowsForEmail, { researchId, now })
// rowsForEmail: [{ id, research_id, confirmed_at, unsubscribed_at, confirm_sent_at, confirm_send_count }]
// -> { action: 'noop' | 'insert-confirmed' | 'insert-unconfirmed' | 'reactivate' | 'resend',
//      rowId?, sendConfirmation: boolean }
```

Rules the function encodes (unit-tested exhaustively):

- Active confirmed row for the same (email, researchId) pair -> `noop`.
- Email has ANY active confirmed row (mailbox already proven) -> new pair
  inserts with `confirmed_at = now`, no email sent.
- New address -> insert unconfirmed, `sendConfirmation: true`.
- Pair exists unconfirmed -> `resend`, but `sendConfirmation` is false when
  `max(confirm_sent_at)` across the address is younger than
  `CONFIRM_COOLDOWN_S` or `sum(confirm_send_count)` >= `CONFIRM_MAX_SENDS`.
- Pair exists unsubscribed -> `reactivate`: clear `unsubscribed_at`, clear
  `confirmed_at`, issue a fresh `confirm_token`, reset `confirm_send_count`,
  then the confirmation rules above apply (fresh consent cycle).

**`worker/handlers/subscribe.js` edits (order inside the handler):**

1. Method check (unchanged).
2. `const ip = request.headers.get('CF-Connecting-IP') || 'unknown'` (same
   idiom as `research.js:117`).
3. `checkBurstGate(env.RL_BURST, 'subscribe:' + ip)` -> 429 with
   `Retry-After` on block.
4. `checkRateLimit(env.KV, 'subscribe:' + ip, 5, 3600)` -> 429 on block.
5. Parse and validate body (unchanged).
6. `SELECT` all rows for the address, run `decideSubscribeAction`, apply the
   returned action with parameterized statements.
7. When `sendConfirmation` is true: fetch the research query for context when
   `researchId` is set (`SELECT query FROM research WHERE id = ?1`), build
   `confirmationEmail`, `await sendMail(...)`. On `ok`, update
   `confirm_sent_at = now` and `confirm_send_count = confirm_send_count + 1`
   for every row of that address. On failure, leave `confirm_sent_at` as it
   was so the next submit retries.
8. Always return the generic `{ ok: true }` on well-formed input. No response
   difference between new, repeat, confirmed, or cooldown states (no
   enumeration surface).

**Confirm route.** `worker/handlers/confirm.js`, wired in `worker/index.js`
next to `/unsubscribe`:

```js
export async function handleConfirm(request, env)   // GET /confirm?token=<confirm_token>
```

- Missing token -> 400 page. Unknown token -> 404 page. Reuse the same
  self-contained `page()` HTML style as `unsubscribe.js`.
- Expired (`confirm_sent_at` older than `CONFIRM_TTL_S`) -> page that says the
  link expired and invites a fresh signup. No state change.
- Valid -> `UPDATE subscribers SET confirmed_at = <now> WHERE email = (SELECT
  email FROM subscribers WHERE confirm_token = ?1) AND confirmed_at IS NULL
  AND unsubscribed_at IS NULL`, then a success page. Confirming once proves
  the mailbox for every pending row of that address. Idempotent: a second
  click gets the same success page.

### 5.6 Notification flow (the reason the list exists)

**Trigger point.** Inside `persistEngineResult` in
`worker/pipeline/orchestrator.js`, in the existing `won === true` block, right
beside the IndexNow submit (which already builds
`https://chrisputer.tech/research/${slug}` at line ~254). Reason: that block
is the single choke point every completion path crosses (queue consumer in
`worker/jobs.js`, the scheduled fallback, the flywheel, and the external
worker's `/api/internal/complete` handoff). A hook only in `jobs.js` would
miss three of those four paths. The `won` idempotency latch also guarantees at
most one notify per completion even when two processors race.

```js
// inside the won block, own try/catch, NEVER rethrows:
try {
    await notifySubscribersForResearch(env, { researchId: reportId, query, slug });
} catch (err) {
    console.error(JSON.stringify({ where: 'notify', error: String(err?.message || err) }));
}
```

A failed send can never fail the research run: the research row is already
committed by the `env.DB.batch` before this hook runs, and the hook swallows
everything.

**`worker/lib/notify.js`:**

```js
export const NOTIFY_DEDUPE_S = 3600;
export const NOTIFY_MAX_RECIPIENTS = 100;
export async function notifySubscribersForResearch(env, { researchId, query, slug })
// -> { sent, failed, skipped }   NEVER throws.
```

- Recipient query (the contract from `unsubscribe.js` plus double opt-in):

```sql
SELECT id, email, unsub_token FROM subscribers
 WHERE research_id = ?1
   AND unsubscribed_at IS NULL
   AND confirmed_at IS NOT NULL
   AND (last_notified_at IS NULL OR last_notified_at < ?2)  -- ?2 = now - 3600
 LIMIT 100
```

- Sequential loop, one `sendMail` per recipient (one RCPT per message, no
  BCC). On success, `UPDATE subscribers SET last_notified_at = <now> WHERE id
  = ?1`. On failure, log and continue: the row stays eligible and the next
  re-research retries naturally. Notifications are best-effort by product
  definition, the report page is the source of truth.
- Rows with `research_id IS NULL` (general list) are out of scope for v1 and
  receive nothing. Verification-kind rows are also out of scope (the subscribe
  UI lives on ranking research pages only).
- A burst larger than the Hostinger hourly cap surfaces as SMTP 4xx/5xx
  replies. The loop records those as `failed`, does not retry in-run, and the
  `MAIL_DAILY_CAP` governor (5.4) bounds the total independently.

### 5.7 Unsubscribe flow

The existing one-click contract is honoured as written in the
`unsubscribe.js` header: every notification email carries

```
List-Unsubscribe: <https://chrisputer.tech/unsubscribe?token=UNSUB_TOKEN>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```

and the handler already accepts the RFC 8058 POST with no confirmation step.
The unsubscribe takes effect immediately on the database UPDATE, before any
mail moves.

**Edit to `worker/handlers/unsubscribe.js`:** after the successful UPDATE,
best-effort send the receipt, wrapped so it can never change the response:

```js
try { await sendMail(env, unsubReceiptEmail(row.email)); } catch { /* logged in sendMail */ }
```

The receipt is a one-time transactional acknowledgement triggered by the
user's own action. It is exempt from the active-recipient predicate by
definition, and it carries no List-Unsubscribe header (there is no list
membership left to leave).

### 5.8 Abuse resistance (unauthenticated POST)

Layers, outermost first:

1. Burst gate: `RL_BURST` binding, key `subscribe:<ip>`, 10 per 60 s (shared
   binding config, fail-open per `burst-gate.js`).
2. KV hourly window: `subscribe:<ip>`, 5 per 3600 s.
3. Per-address cooldown: at most one confirmation email per address per 24 h
   (`CONFIRM_COOLDOWN_S`), regardless of IP.
4. Per-address lifetime cap: at most 3 confirmation emails ever
   (`CONFIRM_MAX_SENDS`) until the 30-day purge resets the row.
5. Double opt-in: an unconfirmed address never receives a notification, only
   the capped confirmation message.
6. Global governor: `MAIL_DAILY_CAP` stops all outbound at 200 per UTC day.

Worst case for a victim address under all layers: 3 small confirmation emails
across 30 days. Responses stay identical in every state, so the endpoint
leaks no membership information.

### 5.9 Secret exposure, stated honestly

`TRUERANK_SMTP_PASSWORD` is the full mailbox password. A Worker-secret
compromise therefore exposes reading the owner's mail, not only sending.
Accepted for v1 because the secret lives only in BWS and the Cloudflare secret
store, both already trusted with equivalent keys. Mitigations: rotate by
changing the mailbox password and re-running `wrangler secret put`. Hardening
option if this ever feels wrong: create a second Hostinger mailbox
`notify@chrisputer.tech`, authenticate as it, keep `Reply-To:
chris@chrisputer.tech`. That trades the exact From address for a contained
blast radius. Not chosen now because From = the human mailbox is the product
point.

### 5.10 Email templates (`worker/lib/email-templates.js`)

All three functions are pure and return `{ subject, text, html }`. HTML is a
minimal single-column document (system font stack, dark-on-light, one link),
no images, no tracking pixels, no external assets. The text part is the
canonical copy. `${...}` values are HTML-escaped in the html part with the
same escaping idiom the pages use.

**1. `confirmationEmail({ query, confirmUrl })`**

- Subject: `Confirm your TrueRank email notification`
- Text:

```
You asked TrueRank to email you when research on "{query}" is ready.

Confirm this address to turn the notification on:

{confirmUrl}

The link works for 7 days. If you did not request this, ignore this
email. We will not email you again.

Chris
chrisputer.tech
```

When `query` is unknown, the first line reads `You asked TrueRank to email
you when new research is ready.`

**2. `reportReadyEmail({ query, reportUrl, unsubUrl })`**

- Subject: `Your TrueRank report is ready: {query}`
- Extra headers: `List-Unsubscribe` + `List-Unsubscribe-Post` (values in 5.7).
- Text:

```
The research you asked about is done.

  "{query}"
  Read the report: {reportUrl}

You get this email because you asked for one notification about this
report on chrisputer.tech. Reply to this email to reach a human.

One-click unsubscribe: {unsubUrl}
```

`reportUrl` = `https://chrisputer.tech/research/{slug}` (same construction as
the IndexNow submit). `unsubUrl` =
`https://chrisputer.tech/unsubscribe?token={unsub_token}` using that
recipient row's token.

**3. `unsubReceiptEmail()`**

- Subject: `You are unsubscribed from TrueRank`
- Text:

```
This confirms your unsubscribe request. We removed your address from
all TrueRank email notifications. We will not send you further email.

If this was a mistake, subscribe again on any report page.

Chris
chrisputer.tech
```

### 5.11 Privacy page edit

Add one bullet to the "Other services we rely on" list in
`public/privacy.html` (matching the existing bullet markup):

> **Email notifications.** If you ask for an email when a report is ready, we
> store your address in our database (Cloudflare D1) and send the message
> through Resend, our email delivery provider (servers in the US). Your address
> is used only for the notifications you requested. Every notification
> contains a one-click unsubscribe link.

(Updated 2026-10-19, CP-622: Resend replaced Hostinger as the sender, so it is
named as a new data processor.)

### 5.12 Fallback behaviour summary

| Condition | Behaviour |
|---|---|
| Secrets absent (local dev, CI, tests) | `sendMail` returns `{ ok:false, skipped:'not-configured' }`. Handlers still return their normal responses. No socket opens. |
| `MAIL_ENABLED = "false"` | Same skip, reason `disabled`. Subscribe still stores rows (unconfirmed). They become confirmable when mail returns. |
| Hostinger SMTP down / timeout | Per-send failure logged. Subscribe responds `{ok:true}` and retries the confirmation on the user's next submit after cooldown. Notify marks `failed` and moves on. The research run is never affected. |
| Daily cap reached | Skip with reason `daily-cap`. Counter visible in KV for diagnosis. |
| Burst above Hostinger hourly cap | SMTP 4xx/5xx recorded as failures, no in-run retry, natural retry on the next completion. |

## 6. DNS records, exactly

Zone DNS lives on Cloudflare. The mailbox lives on Hostinger. Verified live on
2026-07-28 with dig: everything mail needs for option A ALREADY EXISTS.
Publish nothing new for sending. Keep these as they are (all DNS-only, never
proxied):

| Record | Name | Value | Publisher |
|---|---|---|---|
| MX | `chrisputer.tech` | `5 mx1.hostinger.com`, `10 mx2.hostinger.com` | Present (Hostinger values, owner-published in Cloudflare DNS) |
| TXT (SPF) | `chrisputer.tech` | `v=spf1 include:_spf.mail.hostinger.com ~all` | Present |
| CNAME (DKIM) | `hostingermail-a._domainkey` | `hostingermail-a.dkim.mail.hostinger.com` | Present |
| CNAME (DKIM) | `hostingermail-b._domainkey` | `hostingermail-b.dkim.mail.hostinger.com` | Present |
| CNAME (DKIM) | `hostingermail-c._domainkey` | `hostingermail-c.dkim.mail.hostinger.com` | Present |
| TXT (DMARC) | `_dmarc` | `v=DMARC1; p=none` today | Present, upgrade below |

One change is recommended (owner action in the Cloudflare dashboard, not
code):

1. Now: `_dmarc` TXT -> `v=DMARC1; p=none; rua=mailto:chris@chrisputer.tech; fo=1`
   (adds aggregate reporting so alignment is observable).
2. After 2 weeks of clean reports: tighten to
   `v=DMARC1; p=quarantine; rua=mailto:chris@chrisputer.tech; fo=1`.

**Resend records (CP-622).** Sending through Resend (region us-east-1) adds
three records, all DNS only. None of them touches the root SPF, the root MX or
the Hostinger DKIM records above:

| Record | Name | Value |
|---|---|---|
| TXT (DKIM) | `resend._domainkey` | the public key shown in the Resend dashboard for `chrisputer.tech` |
| MX | `send` | `10 feedback-smtp.us-east-1.amazonses.com` |
| TXT (SPF) | `send` | `v=spf1 include:amazonses.com ~all` |

**SPF conflict rule, for the record.** A name may hold ONE SPF TXT record. If
a second sender is ever added (Resend class or Cloudflare Email Service), its
root-domain SPF must be MERGED into the existing value
(`v=spf1 include:_spf.mail.hostinger.com include:<other> ~all`), never added
as a second TXT record. Two SPF records = permerror = both senders fail
authentication. Providers that scope SPF to a return-path subdomain (Resend,
Postmark) avoid the root merge entirely. Cloudflare Email Service currently
auto-adds a root SPF record during onboarding, which is exactly this hazard,
and is part of why it is deferred until GA.

## 7. Test plan

The seam (5.3) means no test run can ever send real mail: unit tests inject a
fake socket, integration tests inject `env.__mailTransport`, and both harness
environments lack the secrets anyway, so even an un-stubbed path degrades to a
logged skip.

**Unit (`node scripts/run-tests.mjs`, new suites registered in the runner):**

- `test/unit/email-mime.test.js`: header set completeness, CRLF injection
  rejection (`\r`/`\n` in subject, to, extra headers), base64 wrap at 76
  cols, RFC 2047 subject for a non-ASCII query, boundary uniqueness,
  List-Unsubscribe passthrough, deterministic output given fixed inputs.
- `test/unit/smtp.test.js`: drive `sendViaSmtp` with a scripted fake io.
  Cases: happy path (assert exact client command sequence and dot-stuffed
  DATA), multiline `250-` EHLO reply, 535 auth failure -> `SmtpError`
  {code:535, step:'auth'} with no password in the message, 4xx at RCPT,
  timeout (fake io that never resolves -> deadline rejection), dot-stuffing
  of a body line that starts with `.`.
- `test/unit/email-templates.test.js`: each template contains its URL, the
  notification carries the unsub link in body AND headers, HTML part escapes
  a query containing `<script>`, receipt has no List-Unsubscribe.
- `test/unit/subscribe-flow.test.js`: `decideSubscribeAction` truth table:
  new address, repeat pair, confirmed elsewhere, cooldown suppression,
  lifetime cap, reactivate after unsubscribe.

**Integration (`npx vitest run`, Miniflare-backed real D1/KV):**

- `test/integration/email-flows.spec.js` (env from `cloudflare:test`, handlers
  called in-process, `env.__mailTransport` = recording stub):
  - subscribe -> row inserted unconfirmed, exactly one transport call, raw
    message contains the confirm URL, `confirm_sent_at` set.
  - repeat subscribe inside cooldown -> `{ok:true}`, NO second transport call.
  - GET /confirm with the token -> `confirmed_at` set for all rows of the
    address, expired token -> no change.
  - seeded complete research + confirmed/unconfirmed/unsubscribed subscribers
    -> `notifySubscribersForResearch` sends to exactly the confirmed active
    row, sets `last_notified_at`, honours the 1-hour dedupe on a second call.
  - transport stub that throws -> notify returns `{failed:1}` and the spec's
    research row stays `complete` (never fails the run).
  - unsubscribe POST -> rows updated AND one receipt transport call.
  - secrets absent and NO stub -> `sendMail` returns skip, no throw (proves
    the harness can never send).
- `test/integration/_schema.js`: add `import confirm from
  '../../schema/013_subscribers_confirm.sql?raw'` to the applied list.

**Manual smoke (one-off, owner-run, the only real send):**
`bws-exec TRUERANK_RESEND_API_KEY -- node scripts/send-test-email.mjs --to chris@chrisputer.tech`
reuses `resend.js` with Node's built-in fetch (never deployed).
Then inspect the received message's `Authentication-Results` header for
`spf=pass` and `dkim=pass` with `header.d=chrisputer.tech`. That validates the
whole deliverability chain once, end to end.

## 8. Rollback

1. Instant, config-only: set `MAIL_ENABLED = "false"` and push (or flip with a
   dashboard var edit). All sends become logged skips. Subscribe, confirm,
   and unsubscribe pages keep working. No data loss.
2. Secret revocation: change the Hostinger mailbox password. Sends fail
   gracefully (535 logged), everything else unaffected. Update or delete the
   Worker secrets at leisure.
3. Full code rollback: revert the feature commits. Migration 013 is additive
   and nullable, so old code runs against the new schema untouched. Do NOT
   write a down-migration. Pre-existing behaviour (store rows, send nothing)
   returns exactly.
4. Transport swap (forward "rollback" to option B/C2 at the thresholds in
   section 4): replace the default transport inside `mailer.js`. No handler,
   template, schema, or test-seam change. The provider's DNS records get
   added under the SPF merge rule in section 6.
