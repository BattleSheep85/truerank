/**
 * Product-verification pages: the /verify entry form and the /verify/:slug
 * status + report page. Styled in the "Forensic Instrument" language (see
 * public/concepts/b-forensic.html) via the shared `layout()` shell — mono
 * data readouts, hairline borders, SVG score gauge, plain-language verdict
 * first. Additive-only — no ranking-page behavior is touched.
 */

import { layout, jsonForScript } from '../lib/html.js';
import { escapeHtml, displayQuery, isValidHttpsUrl, parseJsonSafe } from '../lib/utils.js';
import { getResearchBySlug, findRankingForCategory } from '../lib/db.js';
import { buildAffiliateUrl, retailerLabel, resolveAmazonTag } from '../lib/affiliate-links.js';
import { starMarkup, renderItemImage } from './research-primitives.js';
import { overallVerdict, INSUFFICIENT_EVIDENCE_LABEL } from '../lib/verdict.js';

// Longest prefill the entry form keeps. A pasted product link can be long.
const MAX_PREFILL_LENGTH = 2048;

/**
 * GET /verify — the product-entry form. `prefillProduct` comes from the
 * home page's ?product= handoff (Mass search demoted the direct API call;
 * home now just navigates here with the typed text) — pre-filled but never
 * auto-submitted, so the user still confirms before spending a verify run.
 */
export function renderVerifyEntryPage(prefillProduct = '') {
    const prefill = String(prefillProduct || '').slice(0, MAX_PREFILL_LENGTH);
    const body = `<div class="grid-bg border-b border-line">
<div class="mx-auto max-w-3xl px-6 py-12 md:py-16">
<nav aria-label="Breadcrumb" class="mb-6 font-mono text-[11px] uppercase tracking-widest text-ink-3">
<a href="/" class="hover:text-ink">Home</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<span class="text-ink-2">Verify a product</span>
</nav>

<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Instrument &middot; Claim verification console</p>
<h1 class="mt-3 font-serif text-h1 font-semibold text-ink">Verify a product&rsquo;s claims</h1>
<p class="mt-3 max-w-xl text-body text-ink-2">Paste a product link or type its name. We check what it claims about itself against independent sources &mdash; specs, reviews, warranty terms &mdash; and score how well the claims hold up.</p>

<form id="verify-form" class="verify-form mt-8 border border-line bg-surface-1">
<div class="flex flex-col gap-0 sm:flex-row">
<label for="verify-product" class="sr-only">Product link or name</label>
<input type="text" id="verify-product" name="product" required minlength="3" maxlength="${MAX_PREFILL_LENGTH}" placeholder="Paste a product link or type its name" value="${escapeHtml(prefill)}" class="w-full border-b border-line bg-transparent px-4 py-4 font-mono text-sm text-ink outline-none placeholder:text-ink-3 focus:bg-surface-2 sm:border-b-0 sm:border-r">
<button type="submit" id="verify-submit" class="shrink-0 bg-ink px-6 py-4 font-mono text-sm font-semibold uppercase tracking-wide text-bg transition-colors hover:bg-accent">Verify it &#9656;</button>
</div>
</form>

<div id="verify-status" class="mt-6" role="status" aria-live="polite"></div>
</div>
</div>

<script nonce="__CSP_NONCE__">
(function(){
  var form = document.getElementById('verify-form');
  var statusBox = document.getElementById('verify-status');
  var submitBtn = document.getElementById('verify-submit');
  if (!form) return;

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'Verifying…' : 'Verify it ▸';
  }

  function showMessage(text, isError, signupRequired) {
    statusBox.innerHTML = '';
    var p = document.createElement('p');
    p.className = isError ? 'font-mono text-xs text-trust-low' : 'font-mono text-xs text-ink-2';
    p.textContent = text;
    statusBox.appendChild(p);
    if (signupRequired) {
      var link = document.createElement('a');
      link.href = '/account';
      link.className = 'mt-3 inline-flex items-center justify-center gap-2 bg-accent-strong px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover';
      link.textContent = 'Create a free account';
      statusBox.appendChild(link);
    }
  }

  function renderUrlPrompt(reportId, product, message) {
    statusBox.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'border border-line bg-surface-1 p-4';
    var msg = document.createElement('p');
    msg.className = 'mb-3 font-mono text-xs text-ink-2';
    msg.textContent = message || 'We couldn\\'t find that product\\'s page — paste its Amazon / Best Buy / Walmart / manufacturer URL.';
    var urlForm = document.createElement('form');
    urlForm.className = 'flex flex-wrap gap-2';
    var input = document.createElement('input');
    input.type = 'url';
    input.required = true;
    input.placeholder = 'https://...';
    input.className = 'min-w-[14rem] flex-1 border border-line bg-bg px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'bg-accent-strong px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-white hover:bg-accent-hover';
    btn.textContent = 'Continue';
    urlForm.appendChild(input);
    urlForm.appendChild(btn);
    wrap.appendChild(msg);
    wrap.appendChild(urlForm);
    statusBox.appendChild(wrap);

    urlForm.addEventListener('submit', function (e) {
      e.preventDefault();
      submitVerify({ reportId: reportId, productUrl: input.value.trim(), product: product });
    });
  }

  function poll(reportId, slug, product) {
    fetch('/api/verify/' + encodeURIComponent(reportId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status === 'needs_input' || data.needsUrl) {
          setBusy(false);
          renderUrlPrompt(reportId, product, data.message);
          return;
        }
        if (data.status === 'completed') {
          showMessage('Done. Opening your report…', false);
          window.location.href = '/verify/' + (data.slug || slug);
          return;
        }
        if (data.status === 'error') {
          setBusy(false);
          showMessage('Verification failed — please try again.', true);
          return;
        }
        setTimeout(function () { poll(reportId, slug, product); }, 2000);
      })
      .catch(function () {
        setTimeout(function () { poll(reportId, slug, product); }, 3000);
      });
  }

  function submitVerify(payload) {
    setBusy(true);
    showMessage('Submitting…', false);
    fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.error) {
          setBusy(false);
          showMessage(data.error, true, data.code === 'signup_required');
          return;
        }
        showMessage('Queued. Checking on it…', false);
        poll(data.id, data.slug, payload.product);
      })
      .catch(function () {
        setBusy(false);
        showMessage('Could not reach the server. Please try again.', true);
      });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var product = document.getElementById('verify-product').value.trim();
    if (product.length < 3) return;
    submitVerify({ product: product });
  });
})();
</script>`;

    return layout(
        'Verify a product',
        'Check a product\'s claims against independent sources and get an honest verdict.',
        body,
        '<meta name="robots" content="noindex, nofollow">',
        { ogUrl: 'https://chrisputer.tech/verify' },
    );
}

/**
 * GET /verify/:slug — status/poll page while processing, minimal report once
 * complete. Returns null when no row matches the slug (caller 404s).
 */
export async function renderVerifyResultPage(slug, env) {
    const row = await getResearchBySlug(env.DB, slug);
    if (!row || row.kind !== 'verification') return null;

    if (row.status === 'complete') {
        return await renderCompleteReport(row, env);
    }

    return renderProcessingPage(row);
}

function renderProcessingPage(row) {
    const prettyProduct = displayQuery(row.query);
    const isNeedsInput = row.status === 'needs_input';

    const body = `<div class="grid-bg border-b border-line">
<div class="mx-auto max-w-2xl px-6 py-12 md:py-16">
<nav aria-label="Breadcrumb" class="mb-6 font-mono text-[11px] uppercase tracking-widest text-ink-3">
<a href="/" class="hover:text-ink">Home</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<a href="/verify" class="hover:text-ink">Verify</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<span class="text-ink-2">${escapeHtml(prettyProduct)}</span>
</nav>

<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Instrument &middot; Audit in progress</p>
<h1 class="mt-3 font-serif text-h1 font-semibold text-ink">Verifying &ldquo;${escapeHtml(prettyProduct)}&rdquo;</h1>

<div id="processing" class="mt-6 border border-line bg-surface-1 p-5">
<div class="flex items-center gap-3">
<div class="spinner" style="width:1.25rem;height:1.25rem;border-width:2px;margin:0;flex-shrink:0"></div>
<p id="verify-status-text" class="font-mono text-xs text-ink-2">${isNeedsInput ? 'Waiting for a product URL…' : 'Checking claims against independent sources…'}</p>
</div>
</div>

<div id="verify-url-prompt" class="mt-6"${isNeedsInput ? '' : ' style="display:none"'}>
${isNeedsInput ? renderUrlPromptMarkup(row.preview) : ''}
</div>
</div>
</div>

<script nonce="__CSP_NONCE__">
(function(){
  var reportId = ${jsonForScript(row.id)};
  var slug = ${jsonForScript(row.slug)};
  var product = ${jsonForScript(row.query)};
  var needsInput = ${isNeedsInput ? 'true' : 'false'};

  function poll() {
    fetch('/api/verify/' + encodeURIComponent(reportId))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.status === 'needs_input' || data.needsUrl) {
          if (!needsInput) {
            needsInput = true;
            document.getElementById('verify-status-text').textContent = 'Waiting for a product URL…';
            var promptBox = document.getElementById('verify-url-prompt');
            promptBox.style.display = '';
            promptBox.innerHTML = ${jsonForScript('')};
            renderPrompt(data.message);
          }
          setTimeout(poll, 3000);
          return;
        }
        if (data.status === 'completed') {
          window.location.href = '/verify/' + (data.slug || slug);
          return;
        }
        if (data.status === 'error') {
          document.getElementById('verify-status-text').textContent = 'Verification failed — please try again.';
          return;
        }
        setTimeout(poll, 2000);
      })
      .catch(function () { setTimeout(poll, 3000); });
  }

  function renderPrompt(message) {
    var box = document.getElementById('verify-url-prompt');
    box.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'border border-line bg-surface-1 p-4';
    var msg = document.createElement('p');
    msg.className = 'mb-3 font-mono text-xs text-ink-2';
    msg.textContent = message || 'We couldn\\'t find that product\\'s page — paste its URL to continue.';
    var urlForm = document.createElement('form');
    urlForm.className = 'flex flex-wrap gap-2';
    var input = document.createElement('input');
    input.type = 'url';
    input.required = true;
    input.placeholder = 'https://...';
    input.className = 'min-w-[14rem] flex-1 border border-line bg-bg px-3 py-2 font-mono text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25';
    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'bg-accent-strong px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-white hover:bg-accent-hover';
    btn.textContent = 'Continue';
    urlForm.appendChild(input);
    urlForm.appendChild(btn);
    wrap.appendChild(msg);
    wrap.appendChild(urlForm);
    box.appendChild(wrap);

    urlForm.addEventListener('submit', function (e) {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Submitting…';
      fetch('/api/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportId: reportId, product: product, productUrl: input.value.trim() }),
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) {
            btn.disabled = false;
            btn.textContent = 'Continue';
            msg.textContent = data.error;
            return;
          }
          document.getElementById('verify-status-text').textContent = 'Checking claims against independent sources…';
          box.style.display = 'none';
          needsInput = false;
          poll();
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = 'Continue';
        });
    });
  }

  if (needsInput) renderPrompt(${jsonForScript(row.preview || '')});
  setTimeout(poll, needsInput ? 3000 : 1500);
})();
</script>`;

    return {
        html: layout(
            `Verifying ${prettyProduct}`,
            `Checking "${prettyProduct}"'s claims against independent sources.`,
            body,
            '<meta name="robots" content="noindex, nofollow">',
            { ogUrl: `https://chrisputer.tech/verify/${row.slug}` },
        ),
        lastModified: row.created_at,
    };
}

// Server-side fallback markup for the URL prompt (progressive enhancement —
// the inline script above re-renders it via renderPrompt on first paint, but
// this ensures something usable shows even if JS is briefly slow to run).
function renderUrlPromptMarkup(message) {
    return `<div class="border border-line bg-surface-1 p-4">
<p class="mb-3 font-mono text-xs text-ink-2">${escapeHtml(message || "We couldn't find that product's page — paste its Amazon / Best Buy / Walmart / manufacturer URL.")}</p>
</div>`;
}

// Verdict pill styling per claim status. Bordered instrument-readout style —
// glyph + label together so the state never relies on color alone. Uses only
// compiled Tailwind utilities (custom trust-* palette) — no new classes.
const VERDICT_PILL = {
    verified: { label: 'Verified', glyph: '&#10003;', border: 'border-trust-high', text: 'text-trust-high' },
    'partially-verified': { label: 'Partially verified', glyph: '&#9680;', border: 'border-trust-medium', text: 'text-trust-medium' },
    unsubstantiated: { label: 'Unsubstantiated', glyph: '&#9650;', border: 'border-line-strong', text: 'text-ink-3' },
    contradicted: { label: 'Contradicted', glyph: '&#10005;', border: 'border-trust-low', text: 'text-trust-low' },
};

function verdictPill(status) {
    return VERDICT_PILL[status] || { label: 'Unknown', glyph: '?', border: 'border-line-strong', text: 'text-ink-3' };
}

// Overall score band -> trust color + glyph, per the brief's thresholds.
// Icon travels with the color so the band is never color-only.
// A null score (not enough evidence) gets the neutral band.
const NEUTRAL_BAND = { bg: 'bg-surface-2', text: 'text-ink-3', stroke: 'text-ink-3', glyph: '&#9650;' };

function scoreBandClasses(score) {
    if (typeof score !== 'number') return NEUTRAL_BAND;
    const n = score;
    if (n >= 80) return { bg: 'bg-trust-high-bg', text: 'text-trust-high', stroke: 'text-trust-high', glyph: '&#10003;' };
    if (n >= 60) return { bg: 'bg-trust-high-bg', text: 'text-trust-high', stroke: 'text-trust-high', glyph: '&#10003;' };
    if (n >= 40) return { bg: 'bg-trust-medium-bg', text: 'text-trust-medium', stroke: 'text-trust-medium', glyph: '&#9680;' };
    if (n >= 20) return { bg: 'bg-trust-low-bg', text: 'text-trust-low', stroke: 'text-trust-low', glyph: '&#9650;' };
    return { bg: 'bg-trust-low-bg', text: 'text-trust-low', stroke: 'text-trust-low', glyph: '&#10005;' };
}

// Claim status -> sort rank for the "worst first" ledger ordering: a reader
// scanning top-to-bottom sees the problems before the confirmations.
const STATUS_SORT_RANK = {
    contradicted: 0,
    unsubstantiated: 1,
    'partially-verified': 2,
    verified: 3,
};

function claimTypeLabel(type) {
    const map = { spec: 'Spec', warranty: 'Warranty', marketing: 'Marketing', support: 'Support' };
    return map[type] || 'Claim';
}

// Independence/conflict tags -> short human chip labels. Anything not in this
// map is dropped rather than rendering a raw internal tag name.
const EVIDENCE_TAG_CHIPS = {
    'affiliate-conflict': 'affiliate',
    'sponsored-content': 'sponsored',
    'seeded-unit': 'seeded unit',
    'incentivized-review': 'incentivized',
    'nda-embargo': 'NDA/embargo',
    manufacturer: 'manufacturer',
};

function evidenceTagChips(tags) {
    const list = Array.isArray(tags) ? tags : [];
    return list
        .map((t) => EVIDENCE_TAG_CHIPS[t])
        .filter(Boolean)
        .map((label) => `<span class="ml-2 inline-block border border-line-strong px-1.5 py-0.5 font-mono text-[10.5px] uppercase tracking-wide text-ink-3">${escapeHtml(label)}</span>`)
        .join('');
}

function evidenceHost(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return url;
    }
}

function truncateSpan(span, max = 160) {
    const s = String(span || '').trim();
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

// Clamp a 0-100 readout for use as a bar-indicator width.
function clampPct(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return 0;
    return Math.max(0, Math.min(100, v));
}

// Small mono bar + number instrument readout for a 0-100 metric (credibility
// or independence). `tone` picks the fill color band.
function barReadout(label, value) {
    if (!Number.isFinite(value)) {
        return `<span class="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3"><span class="uppercase tracking-wide">${escapeHtml(label)}</span><span>&mdash;</span></span>`;
    }
    const pct = clampPct(value);
    const tone = pct >= 70 ? 'bg-trust-high' : pct >= 40 ? 'bg-trust-medium' : 'bg-trust-low';
    return `<span class="inline-flex items-center gap-1.5 font-mono text-[10.5px] text-ink-3">
<span class="uppercase tracking-wide">${escapeHtml(label)}</span>
<span class="inline-block h-1.5 w-10 bg-line" aria-hidden="true"><span class="block h-1.5 ${tone}" style="width:${pct}%"></span></span>
<span class="readout text-ink-2">${escapeHtml(String(Math.round(pct)))}</span>
</span>`;
}

// One evidence row (supporting or contradicting). `direction` is 'support' or
// 'contradict' — controls the arrow glyph + color accent (paired with text,
// never color alone).
function renderEvidenceRow(item, direction) {
    if (!item) return '';
    const host = evidenceHost(item.url);
    const hostHtml = isValidHttpsUrl(item.url)
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer nofollow" class="font-mono text-xs font-semibold text-ink hover:text-accent">${escapeHtml(host)}</a>`
        : `<span class="font-mono text-xs font-semibold text-ink">${escapeHtml(host)}</span>`;
    const isSupport = direction === 'support';
    const arrow = isSupport
        ? '<span aria-hidden="true" class="text-trust-high">&uarr;</span><span class="sr-only">Supports</span>'
        : '<span aria-hidden="true" class="text-trust-low">&darr;</span><span class="sr-only">Contradicts</span>';
    const cred = Number.isFinite(item.credibility) ? Math.round(item.credibility) : null;
    const indep = Number.isFinite(item.independence) ? Math.round(item.independence) : null;
    const readoutsHtml = (cred != null || indep != null)
        ? `<span class="ml-2 flex flex-wrap items-center gap-3">${barReadout('cred', cred)}${barReadout('indep', indep)}</span>`
        : '';
    const span = truncateSpan(item.span);
    return `<li class="border-t border-line py-3 first:border-t-0">
<div class="flex flex-wrap items-center gap-y-1.5">
${arrow}
<span class="ml-1.5">${hostHtml}</span>
${readoutsHtml}
${evidenceTagChips(item.tags)}
</div>
${span ? `<p class="mt-1.5 pl-4 text-body-sm italic text-ink-2">&ldquo;${escapeHtml(span)}&rdquo;</p>` : ''}
</li>`;
}

function renderClaimCard(claim) {
    const pill = verdictPill(claim.status);
    const confidencePct = Number.isFinite(claim.confidence) ? Math.round(claim.confidence * 100) : null;
    const supporting = (claim.supporting || []).slice(0, 3);
    const contradicting = (claim.contradicting || []).slice(0, 2);
    const hasEvidence = supporting.length > 0 || contradicting.length > 0;

    const evidenceHtml = hasEvidence
        ? `<ul class="mt-4 border-t border-line pt-1">
${supporting.map((s) => renderEvidenceRow(s, 'support')).join('')}
${contradicting.map((c) => renderEvidenceRow(c, 'contradict')).join('')}
</ul>`
        : '';

    const unsubstantiatedNote = claim.status === 'unsubstantiated'
        ? `<p class="mt-3 font-mono text-[11px] text-ink-3">No independent source corroborated this — it appears only in the maker&rsquo;s own materials.</p>`
        : '';

    return `<li class="mb-4 border border-line bg-surface-1 p-5">
<div class="flex flex-wrap items-center gap-2">
<span class="inline-flex items-center gap-1 border ${pill.border} px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${pill.text}"><span aria-hidden="true">${pill.glyph}</span> ${escapeHtml(pill.label)}</span>
<span class="border border-line-strong px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wide text-ink-3">${escapeHtml(claimTypeLabel(claim.claimType || claim.type))}</span>
${confidencePct != null ? `<span class="font-mono text-[11px] text-ink-3">confidence <span class="readout text-ink-2">${escapeHtml(String(confidencePct))}%</span></span>` : ''}
<span class="font-mono text-[11px] text-ink-3">${escapeHtml(String(claim.independentCount ?? 0))} independent source${claim.independentCount === 1 ? '' : 's'}</span>
</div>
<p class="mt-3 text-body text-ink">${escapeHtml(claim.text)}</p>
${unsubstantiatedNote}
${evidenceHtml}
</li>`;
}

function sortedClaims(claims) {
    return [...claims].sort((a, b) => {
        const ra = STATUS_SORT_RANK[a.status] ?? 99;
        const rb = STATUS_SORT_RANK[b.status] ?? 99;
        return ra - rb;
    });
}

// Inline SVG score gauge — renders with zero JS. Circumference for r=52 is
// 2*pi*52 ≈ 326.73; dash-offset is computed from the 0-100 score so the arc
// fills clockwise from the top.
function renderScoreGauge(score, band) {
    if (typeof score !== 'number') return renderNoScoreGauge();
    const n = Math.max(0, Math.min(100, score));
    const circumference = 326.73;
    const offset = (circumference * (100 - n)) / 100;
    return `<div class="relative mx-auto h-32 w-32 sm:h-36 sm:w-36">
<svg viewBox="0 0 120 120" class="h-full w-full -rotate-90" role="img" aria-label="Composite score ${escapeHtml(String(Math.round(n)))} out of 100">
<circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-width="10" class="text-line"></circle>
<circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-width="10" stroke-linecap="round" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" class="${band.stroke}"></circle>
</svg>
<div class="absolute inset-0 flex flex-col items-center justify-center">
<span class="readout font-mono text-3xl font-bold text-ink sm:text-4xl">${escapeHtml(String(Math.round(n)))}</span>
<span class="font-mono text-[10px] uppercase tracking-wide text-ink-3">/ 100</span>
</div>
</div>`;
}

// Empty gauge for a null score. It never shows a number.
function renderNoScoreGauge() {
    return `<div class="relative mx-auto h-32 w-32 sm:h-36 sm:w-36">
<svg viewBox="0 0 120 120" class="h-full w-full -rotate-90" role="img" aria-label="No score. ${escapeHtml(INSUFFICIENT_EVIDENCE_LABEL)}">
<circle cx="60" cy="60" r="52" fill="none" stroke="currentColor" stroke-width="10" class="text-line"></circle>
</svg>
<div class="absolute inset-0 flex flex-col items-center justify-center">
<span class="readout font-mono text-sm font-bold text-ink-3">No score</span>
</div>
</div>`;
}

// Instrument panel: score gauge + derived readouts, placed BELOW the
// plain-language verdict headline (verdict-first, instrument-second per the
// design brief). Stats are all derived from real per-claim/evidence data —
// nothing fabricated.
function renderInstrumentPanel(overall, claims, evidenceCount) {
    const band = scoreBandClasses(overall.score);
    const independentClaims = claims.reduce((n, c) => n + (Number(c.independentCount) > 0 ? 1 : 0), 0);
    const conflictTagSet = new Set(Object.keys(EVIDENCE_TAG_CHIPS));
    let flaggedSources = 0;
    for (const c of claims) {
        const items = [...(c.supporting || []), ...(c.contradicting || [])];
        for (const item of items) {
            const tags = Array.isArray(item.tags) ? item.tags : [];
            if (tags.some((t) => conflictTagSet.has(t))) flaggedSources++;
        }
    }

    return `<div class="mt-6 grid gap-5 lg:grid-cols-[280px_1fr]">
<div class="border border-line bg-surface-1 p-6">
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Composite score</p>
<div class="mt-5">${renderScoreGauge(overall.score, band)}</div>
<div class="mt-5 space-y-1.5 border-t border-line pt-4 font-mono text-[11px] text-ink-3">
<div class="flex justify-between"><span>Claims audited</span><span class="readout text-ink">${escapeHtml(String(claims.length))}</span></div>
<div class="flex justify-between"><span>Sources checked</span><span class="readout text-ink">${escapeHtml(String(evidenceCount))}</span></div>
<div class="flex justify-between"><span>Independently corroborated</span><span class="readout text-trust-high">${escapeHtml(String(independentClaims))} / ${escapeHtml(String(claims.length))}</span></div>
<div class="flex justify-between"><span>Conflicted sources flagged</span><span class="readout text-trust-low">${escapeHtml(String(flaggedSources))}</span></div>
</div>
</div>
<div class="border border-line bg-surface-1 p-6">
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Verdict key</p>
<dl class="mt-4 grid gap-3 sm:grid-cols-2">
${Object.values(VERDICT_PILL).map((v) => `<div class="flex items-center gap-2">
<span class="inline-flex items-center gap-1 border ${v.border} px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide ${v.text}"><span aria-hidden="true">${v.glyph}</span> ${escapeHtml(v.label)}</span>
</div>`).join('')}
</dl>
<p class="mt-5 border-t border-line pt-4 font-mono text-[11px] leading-relaxed text-ink-3">Each row below shows the claim, its verdict, and the evidence that produced it — credibility and independence are scored per source, not assumed.</p>
</div>
</div>`;
}

// Score pill text: "<n>/100" for a number, "No score" for null.
function scoreReadout(score) {
    return typeof score === 'number' ? `${score}/100` : 'No score';
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Unix seconds to "Mon D, YYYY" in UTC. Gives '' for a missing or bad value.
export function formatCheckedDate(unixSeconds) {
    const secs = Number(unixSeconds);
    if (!Number.isFinite(secs) || secs <= 0) return '';
    const d = new Date(secs * 1000);
    return `${MONTH_ABBR[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function renderVerdictMeta(overall, completedAt) {
    const checkedOn = formatCheckedDate(completedAt);
    return `<p class="mt-2 max-w-2xl text-body-sm text-ink-2">Frank found independent tests for ${escapeHtml(String(overall.checkedCount))} of ${escapeHtml(String(overall.claimCount))} claims.</p>
${checkedOn ? `<p class="mt-1 font-mono text-[11px] text-ink-3">Checked on ${escapeHtml(checkedOn)}</p>` : ''}`;
}

function renderVerdictHeader(prettyProduct, overall, evidenceCount, completedAt) {
    const band = scoreBandClasses(overall.score);
    const claimCount = overall.claimCount;
    return `<div>
<div class="flex flex-wrap items-center gap-3">
<span aria-hidden="true" class="text-2xl ${band.text}">${band.glyph}</span>
<p class="font-sans text-2xl font-bold text-ink sm:text-3xl">${escapeHtml(overall.label)}</p>
<span class="inline-flex items-center gap-1 border border-current px-2 py-1 font-mono text-xs font-semibold ${band.text}">${escapeHtml(scoreReadout(overall.score))}</span>
</div>
${renderVerdictMeta(overall, completedAt)}
<p class="mt-3 max-w-2xl text-body-sm text-ink-2">We audited ${escapeHtml(String(claimCount))} of ${escapeHtml(prettyProduct)}&rsquo;s claims against ${escapeHtml(String(evidenceCount))} independent evidence source${evidenceCount === 1 ? '' : 's'}.</p>
</div>`;
}

function renderMethodology() {
    return `<details class="mt-8 border border-line bg-surface-1 p-5">
<summary class="cursor-pointer font-mono text-xs font-semibold uppercase tracking-wide text-ink">How this Truth Audit works</summary>
<div class="mt-3 text-body-sm text-ink-2">
<p>Every verdict is evidence-weighted by source credibility × reviewer independence. A claim only earns &ldquo;Verified&rdquo; when at least two independent sources confirm it through their own testing or measurement — echoing the manufacturer&rsquo;s marketing does not count.</p>
<p class="mt-2">Sources tagged as affiliate-conflicted, sponsored, incentivized, or manufacturer-owned are down-weighted or excluded from corroboration, even when they repeat the same claim.</p>
</div>
</details>`;
}

// Buy CTA for the subject product itself. Uses the same buildAffiliateUrl/
// retailerLabel path as research-page.js's resolveProductCtas so the link
// behavior (host allowlist, tag injection, https-only) is identical.
function renderBuyCta(productUrl, env) {
    if (!productUrl || !isValidHttpsUrl(productUrl)) return '';
    const ids = { amazonTag: resolveAmazonTag(env) };
    const affiliateUrl = buildAffiliateUrl(productUrl, ids);
    if (!affiliateUrl || !isValidHttpsUrl(affiliateUrl)) return '';
    const label = `Buy on ${retailerLabel(affiliateUrl)}`;
    return `<div class="mt-8 border border-line bg-surface-1 p-5">
<a href="${escapeHtml(affiliateUrl)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="inline-flex items-center justify-center gap-2 bg-accent-strong px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover">${escapeHtml(label)} <span aria-hidden="true">&#8599;</span></a>
<p class="mt-3 font-mono text-[10.5px] leading-relaxed text-ink-3">We may earn a commission on purchases made through links on this page. Verdicts above are produced from independent evidence analysis and are never influenced by affiliate relationships.</p>
</div>`;
}

// One alternative-product card — a smaller sibling of research-page.js's
// renderProduct, reusing the same image fallback + star markup + affiliate
// CTA path (buildAffiliateUrl/retailerLabel) so the link behavior is
// identical to renderBuyCta above.
function renderAlternativeCard(product, env) {
    const name = String(product.name || '').trim() || 'Product';
    const ids = { amazonTag: resolveAmazonTag(env) };
    const affiliateUrl = buildAffiliateUrl(product.affiliate_url || product.product_url || '', ids);
    const hasBuyLink = affiliateUrl && isValidHttpsUrl(affiliateUrl);
    const buyLabel = hasBuyLink ? `Buy on ${retailerLabel(affiliateUrl)}` : '';
    const oneLiner = product.best_for || product.verdict || '';

    return `<div class="border border-line bg-surface-1 p-4">
${renderItemImage(product.image_url, name, product.id)}
<h3 class="mt-1 text-body-sm font-semibold text-ink">${escapeHtml(name)}</h3>
${product.rating != null ? `<p class="mt-1 font-mono text-[11px] text-ink-2"><span aria-hidden="true">${starMarkup(product.rating)}</span> <span class="readout">${escapeHtml(String(product.rating))}/5</span></p>` : ''}
${oneLiner ? `<p class="mt-2 text-body-sm text-ink-2">${escapeHtml(String(oneLiner).slice(0, 140))}</p>` : ''}
${hasBuyLink ? `<a href="${escapeHtml(affiliateUrl)}" target="_blank" rel="noopener noreferrer nofollow sponsored" class="mt-3 inline-flex items-center justify-center gap-1 bg-accent-strong px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover">${escapeHtml(buyLabel)} <span aria-hidden="true">&#8599;</span></a>` : ''}
</div>`;
}

// "Better alternatives" section — reuses the ranking engine's OUTPUT (an
// existing completed ranking research row for the same category) to point a
// reader at independently-ranked picks. Falls back to a CTA into the ranking
// flow when no matching ranking exists yet. `findRanking` is injected
// (defaults to the real db.js helper) so the unit layer can test this
// without a DB.
/**
 * The verdict to show for a stored verification result. Computes it again from
 * result.claims with overallVerdict. Never reads result.overall or row.overall_score.
 * Never throws: a missing, non-object, or non-array input gives
 * { score: null, label: INSUFFICIENT_EVIDENCE_LABEL, checkedCount: 0, claimCount: 0 }.
 */
export function honestOverall(result) {
    const claims = result && typeof result === 'object' && Array.isArray(result.claims) ? result.claims : [];
    try {
        return overallVerdict(claims);
    } catch {
        return { score: null, label: INSUFFICIENT_EVIDENCE_LABEL, checkedCount: 0, claimCount: 0 };
    }
}

// Only a real number below 50 is low. A null score is not low.
function isLowHonestScore(score) {
    return typeof score === 'number' && score < 50;
}

export async function renderAlternatives(row, resultJson, env, findRanking = findRankingForCategory) {
    const category = String(
        resultJson?.category || row.category || row.topical_category || displayQuery(row.query) || ''
    ).trim();
    if (!category) return '';

    const isLowScore = isLowHonestScore(honestOverall(resultJson).score);

    const heading = isLowScore
        ? 'This one falls short — here are better-rated options'
        : 'Better-rated alternatives — independently ranked';

    let match = null;
    try {
        match = await findRanking(env.DB, category);
    } catch {
        match = null;
    }

    const products = match && Array.isArray(match.products) ? match.products.slice(0, 3) : [];

    if (match && match.research && products.length > 0) {
        const cardsHtml = products.map((p) => renderAlternativeCard(p, env)).join('');
        const rankingSlug = match.research.slug;
        const linkHtml = rankingSlug
            ? `<p class="mt-4 font-mono text-[11px] text-ink-3"><a href="/research/${escapeHtml(rankingSlug)}" class="text-accent underline hover:text-accent-hover">See the full ranking &rarr;</a></p>`
            : '';
        return `<div class="mt-8${isLowScore ? ' border border-trust-low bg-trust-low-bg p-5' : ''}">
<h2 class="font-serif text-h3 font-semibold text-ink">${escapeHtml(heading)}</h2>
<div class="mt-4 grid gap-4 md:grid-cols-3">${cardsHtml}</div>
${linkHtml}
</div>`;
    }

    const compareUrl = `/research/new?q=${encodeURIComponent(`best ${category}`)}`;
    return `<div class="mt-8${isLowScore ? ' border border-trust-low bg-trust-low-bg p-5' : ''}">
<h2 class="font-serif text-h3 font-semibold text-ink">${escapeHtml(heading)}</h2>
<a href="${escapeHtml(compareUrl)}" class="mt-3 inline-flex items-center justify-center gap-2 bg-accent-strong px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover">Compare the best ${escapeHtml(category)} <span aria-hidden="true">&rarr;</span></a>
</div>`;
}

// Page title from the honest verdict. layout() adds " | Frank".
function reportTitle(product, overall) {
    return typeof overall.score === 'number'
        ? `${product}: ${overall.score}/100, ${overall.label}`
        : `${product}: claim check`;
}

// Meta description from the honest verdict. Old row.summary text can carry an old score.
function reportDescription(product, overall) {
    const coverage = `Frank found independent tests for ${overall.checkedCount} of ${overall.claimCount} claims.`;
    const verdict = typeof overall.score === 'number'
        ? `${overall.label} (${overall.score}/100).`
        : `${overall.label}.`;
    return `${product} claim check: ${verdict} ${coverage}`;
}

async function renderCompleteReport(row, env) {
    const prettyProduct = displayQuery(row.query);
    // Old rows can hold odd JSON (null, a number, a list). Treat those as empty.
    const parsed = parseJsonSafe(row.result, {});
    const result = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    const claims = Array.isArray(result.claims) ? result.claims.filter((c) => c && typeof c === 'object') : [];
    const overall = honestOverall({ claims });
    const evidenceCount = Number.isFinite(result.evidenceCount) ? result.evidenceCount : 0;
    const productUrl = result.productUrl || row.subject_url || '';

    const ledgerHtml = claims.length
        ? `<ul class="mt-4">
${sortedClaims(claims).map(renderClaimCard).join('')}
</ul>`
        : `<p class="mt-4 font-mono text-xs text-ink-3">No individual claims were recorded for this run.</p>`;

    // Low-score reports surface the alternatives section EARLY (right after the
    // verdict header, before the claim ledger) — a reader whose subject just
    // failed the audit should see better options before wading through why.
    // Healthy scores keep the section at the bottom, after the buy CTA, as a
    // lower-pressure "you might also like" nudge.
    const isLowScore = isLowHonestScore(overall.score);
    const alternativesHtml = await renderAlternatives(row, result, env);

    const body = `<div class="grid-bg border-b border-line">
<div class="mx-auto max-w-3xl px-6 py-12 md:py-16">
<nav aria-label="Breadcrumb" class="mb-6 font-mono text-[11px] uppercase tracking-widest text-ink-3">
<a href="/" class="hover:text-ink">Home</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<a href="/verify" class="hover:text-ink">Verify</a>
<span aria-hidden="true" class="mx-1.5">/</span>
<span class="text-ink-2">${escapeHtml(prettyProduct)}</span>
</nav>

<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Readout &middot; Truth Audit</p>
<h1 class="mt-2 mb-4 font-serif text-h1 font-semibold text-ink">${escapeHtml(prettyProduct)}</h1>

${renderVerdictHeader(prettyProduct, overall, evidenceCount, row.completed_at)}
${renderInstrumentPanel(overall, claims, evidenceCount)}

${isLowScore ? alternativesHtml : ''}

<h2 class="mt-10 mb-2 font-serif text-h3 font-semibold text-ink">Claim ledger</h2>
${ledgerHtml}

${renderMethodology()}

${renderBuyCta(productUrl, env)}

${isLowScore ? '' : alternativesHtml}
</div>
</div>`;

    return {
        html: layout(
            reportTitle(prettyProduct, overall),
            reportDescription(prettyProduct, overall),
            body,
            '',
            { ogUrl: `https://chrisputer.tech/verify/${row.slug}`, canonical: `https://chrisputer.tech/verify/${row.slug}` },
        ),
        lastModified: row.completed_at || row.created_at,
    };
}
