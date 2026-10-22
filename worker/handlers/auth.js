/**
 * Auth handlers + SSR account pages.
 * POST /api/auth/signup - create account, set session cookie
 * POST /api/auth/login  - verify password, set session cookie
 * POST /api/auth/logout - destroy session, clear cookie
 * POST /api/account/delete - delete account, wipe rows
 * GET  /api/account/export - export user data
 * GET  /account         - past searches (redirects to /login when signed out)
 * GET  /login           - sign in / create account page
 */

import {
    createUser, findUserByEmail, verifyPassword, validEmail, validPassword,
    createSession, destroySession, clearSessionCookie, getSessionUser, getUserSearches,
    deleteUser,
} from '../lib/auth.js';
import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { checkBurstGate } from '../lib/burst-gate.js';
import { layout } from '../lib/html.js';
import { escapeHtml, displayQuery } from '../lib/utils.js';

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
    });
}

// Shared throttle for signup + login attempts: 10/hour/IP. Successful logins
// are rare enough per-IP that sharing the bucket with failures is fine.
// The atomic RL_BURST binding caps concurrency (10/60s) in front of the
// non-atomic KV window: a parallel credential-stuffing burst otherwise reads
// one pre-write state and lands every attempt, each costing 100k PBKDF2 rounds.
async function authRateLimited(request, env) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = await ipRateKey('auth', ip, env);
    const burst = await checkBurstGate(env.RL_BURST, rateKey);
    const check = burst.allowed
        ? await checkRateLimit(env.KV, rateKey, 10, 3600, env.DB)
        : burst;
    return !check.allowed;
}

async function readCredentials(request) {
    let body;
    try { body = await request.json(); } catch { return null; }
    const email = String(body?.email || '').trim();
    const password = String(body?.password || '');
    if (password.length > 1000) return null; // guard against DoS via expensive hash
    return { email, password };
}

export async function handleSignup(request, env) {
    if (await authRateLimited(request, env)) {
        return jsonResponse({ error: 'Too many attempts. Try again later.' }, 429);
    }
    const creds = await readCredentials(request);
    if (!creds) return jsonResponse({ error: 'Invalid request body' }, 400);
    if (!validEmail(creds.email)) return jsonResponse({ error: 'Enter a valid email address.' }, 400);
    if (!validPassword(creds.password)) return jsonResponse({ error: 'Password must be at least 8 characters.' }, 400);

    const existing = await findUserByEmail(env.DB, creds.email);
    if (existing) return jsonResponse({ error: 'An account with that email already exists. Sign in instead.' }, 409);

    let userId;
    try {
        userId = await createUser(env.DB, creds.email, creds.password);
    } catch (err) {
        // Two concurrent requests raced past the findUserByEmail check; the DB
        // UNIQUE constraint caught the second one. Surface the same 409 instead of 500.
        const msg = err instanceof Error ? err.message : String(err);
        if (/UNIQUE constraint failed/i.test(msg)) {
            return jsonResponse({ error: 'An account with that email already exists. Sign in instead.' }, 409);
        }
        throw err;
    }
    const session = await createSession(env.DB, userId);
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': session.cookie });
}

export async function handleLogin(request, env) {
    if (await authRateLimited(request, env)) {
        return jsonResponse({ error: 'Too many attempts. Try again later.' }, 429);
    }
    const creds = await readCredentials(request);
    if (!creds) return jsonResponse({ error: 'Invalid request body' }, 400);

    const user = await findUserByEmail(env.DB, creds.email);
    // Same message for unknown email and wrong password: no account enumeration.
    const failMsg = { error: 'Email or password is incorrect.' };
    if (!user) return jsonResponse(failMsg, 401);
    const ok = await verifyPassword(creds.password, user.password_hash);
    if (!ok) return jsonResponse(failMsg, 401);

    const session = await createSession(env.DB, user.id);
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': session.cookie });
}

export async function handleLogout(request, env) {
    const user = await getSessionUser(request, env);
    if (user) {
        await destroySession(env.DB, user.tokenHash).catch(() => { /* best-effort */ });
    }
    return jsonResponse({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}

export async function handleDeleteAccount(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) {
        return jsonResponse({ error: 'Authentication required.' }, 401);
    }
    let body;
    try { body = await request.json(); } catch { body = {}; }
    if (body?.confirm !== 'DELETE') {
        return jsonResponse({ error: 'Confirmation required. Pass {"confirm":"DELETE"} to delete your account.' }, 400);
    }
    await deleteUser(env.DB, user.id);
    return jsonResponse({ ok: true, message: 'Account and associated data deleted.' }, 200, {
        'Set-Cookie': clearSessionCookie(),
    });
}
export const handleAccountDelete = handleDeleteAccount;

export async function handleExportAccount(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) {
        return jsonResponse({ error: 'Authentication required.' }, 401);
    }
    const userRow = await env.DB.prepare('SELECT id, email, created_at FROM users WHERE id = ?1').bind(user.id).first();
    if (!userRow) {
        return jsonResponse({ error: 'User not found.' }, 404);
    }
    const searches = await getUserSearches(env.DB, user.id, 500);
    const exportData = {
        user: {
            id: userRow.id,
            email: userRow.email,
            created_at: userRow.created_at,
        },
        searches: (searches || []).map((s) => ({
            query: s.query,
            slug: s.slug || null,
            category: s.category || null,
            status: s.status || null,
            created_at: s.created_at,
        })),
        exported_at: Math.floor(Date.now() / 1000),
    };
    return jsonResponse(exportData, 200);
}
export const handleAccountExport = handleExportAccount;

// --- SSR pages ----------------------------------------------------------------

const AUTH_PAGE_SCRIPT = `<script nonce="__CSP_NONCE__">
(function(){
  function wire(formId, endpoint){
    var form=document.getElementById(formId);
    if(!form)return;
    var msg=form.querySelector('[data-msg]');
    form.addEventListener('submit',function(ev){
      ev.preventDefault();
      var email=(form.querySelector('input[name=email]').value||'').trim();
      var password=form.querySelector('input[name=password]').value||'';
      if(msg)msg.textContent='Working\\u2026';
      fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:email,password:password})})
        .then(function(r){return r.json().then(function(d){return{ok:r.ok,d:d}})})
        .then(function(res){
          if(res.ok&&res.d&&res.d.ok){window.location.href='/account';return}
          if(msg)msg.textContent=(res.d&&res.d.error)||'Something went wrong.';
        })
        .catch(function(){if(msg)msg.textContent='Network error. Try again.'});
    });
  }
  wire('login-form','/api/auth/login');
  wire('signup-form','/api/auth/signup');
  var authTabs=document.querySelectorAll('[data-auth-tab]');
  function activateAuthTab(target){
    document.querySelectorAll('[data-auth-panel]').forEach(function(p){p.classList.toggle('hidden',p.dataset.authPanel!==target)});
    authTabs.forEach(function(b){
      var active=b.dataset.authTab===target;
      b.setAttribute('aria-selected',active?'true':'false');
      b.setAttribute('tabindex',active?'0':'-1');
      b.classList.toggle('border-accent',active);b.classList.toggle('text-ink',active);
      b.classList.toggle('border-transparent',!active);b.classList.toggle('text-ink-3',!active);
    });
  }
  authTabs.forEach(function(btn,i){
    btn.setAttribute('tabindex',btn.getAttribute('aria-selected')==='true'?'0':'-1');
    btn.addEventListener('click',function(){activateAuthTab(btn.dataset.authTab)});
    btn.addEventListener('keydown',function(ev){
      var next=i;
      if(ev.key==='ArrowRight')next=(i+1)%authTabs.length;
      else if(ev.key==='ArrowLeft')next=(i-1+authTabs.length)%authTabs.length;
      else if(ev.key==='Home')next=0;
      else if(ev.key==='End')next=authTabs.length-1;
      else return;
      ev.preventDefault();
      activateAuthTab(authTabs[next].dataset.authTab);
      authTabs[next].focus();
    });
  });
})();
</script>`;

// Console-style credential form. Labels are mono/uppercase (matches the
// verify-page instrument vocabulary); inline validation states show on
// :invalid once the field has been touched (peer + :not(:placeholder-shown))
// so an empty untouched field never looks like an error. `data-msg` is the
// server-response readout AUTH_PAGE_SCRIPT writes into on submit.
function authForm(id, submitLabel, autocompletePw) {
    return `<form id="${id}" class="flex flex-col gap-4" novalidate>
<label class="flex flex-col gap-1.5">
<span class="font-mono text-[11px] uppercase tracking-wide text-ink-3">Email</span>
<input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="you@example.com"
  class="peer border border-line bg-bg px-3 py-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 invalid:[&:not(:placeholder-shown)]:border-trust-low">
<span class="hidden font-mono text-[10px] text-trust-low peer-[&:not(:placeholder-shown):invalid]:block">INVALID_FORMAT :: expected user@domain.tld</span>
</label>
<label class="flex flex-col gap-1.5">
<span class="font-mono text-[11px] uppercase tracking-wide text-ink-3">Passcode</span>
<input type="password" name="password" required minlength="8" maxlength="200" autocomplete="${autocompletePw}" placeholder="At least 8 characters"
  class="peer border border-line bg-bg px-3 py-2.5 font-mono text-sm text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent/25 invalid:[&:not(:placeholder-shown)]:border-trust-low">
<span class="hidden font-mono text-[10px] text-trust-low peer-[&:not(:placeholder-shown):invalid]:block">MIN 8 CHARS</span>
</label>
<button type="submit" class="bg-accent-strong px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wide text-white transition-colors hover:bg-accent-hover">${submitLabel} &#9656;</button>
<p data-msg role="status" aria-live="polite" class="min-h-[1.25rem] font-mono text-xs text-trust-low"></p>
</form>`;
}

// What an account unlocks - honest, specific microcopy (no vague "unlock
// premium features"): it bypasses the anonymous per-IP quota gates enforced
// in worker/lib/rate-limit.js (5 mass searches / 10 verifies per IP).
function accountBenefits() {
    return `<div class="mb-6 border-b border-line pb-6">
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Why create an account</p>
<div class="mt-3 space-y-2 font-mono text-xs text-ink-2">
<div class="flex items-start gap-2"><span aria-hidden="true" class="mt-0.5 text-accent">[✓]</span><p>Bypass the free-quota limits: 5 mass searches / 10 verifies per IP without an account.</p></div>
<div class="flex items-start gap-2"><span aria-hidden="true" class="mt-0.5 text-accent">[✓]</span><p>Search history synced across every device you sign in on.</p></div>
<div class="flex items-start gap-2"><span aria-hidden="true" class="mt-0.5 text-accent">[✓]</span><p>Email used only for sign-in and the research alerts you opt into. No spam, ever.</p></div>
</div>
</div>`;
}

export async function renderLoginPage(request, env) {
    const user = await getSessionUser(request, env);
    if (user) {
        return Response.redirect(new URL('/account', request.url).toString(), 302);
    }
    const body = `<div class="grid-bg border-b border-line">
<div class="mx-auto max-w-md px-6 py-16">
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Session &middot; Auth console</p>
<h1 class="mt-2 font-serif text-h1 font-semibold text-ink">Your account</h1>
<p class="mt-2 text-body text-ink-2">Sign in to keep a history of everything you've researched.</p>
<div class="mt-8 border border-line bg-surface-1 p-6">
${accountBenefits()}
<div class="mb-6 flex border-b border-line font-mono text-xs uppercase tracking-wide" role="tablist" aria-label="Account">
<button type="button" role="tab" aria-selected="true" data-auth-tab="login" class="border-b-2 border-accent px-4 py-2 font-semibold text-ink">Sign in</button>
<button type="button" role="tab" aria-selected="false" data-auth-tab="signup" class="border-b-2 border-transparent px-4 py-2 font-semibold text-ink-3">Create account</button>
</div>
<div data-auth-panel="login">${authForm('login-form', 'Sign in', 'current-password')}</div>
<div data-auth-panel="signup" class="hidden">${authForm('signup-form', 'Create account', 'new-password')}</div>
</div>
</div>
</div>`;
    const html = layout('Sign in', 'Sign in to Frank to see your past research.', body, '<meta name="robots" content="noindex, follow">' + AUTH_PAGE_SCRIPT, { canonical: 'https://chrisputer.tech/login' });
    return html;
}

const ACCOUNT_PAGE_SCRIPT = `<script nonce="__CSP_NONCE__" src="/js/list-layouts.js"></script>
<script nonce="__CSP_NONCE__" src="/js/history.js"></script>
<script nonce="__CSP_NONCE__">
(function(){
  var btn=document.getElementById('logout-btn');
  if(btn){
    btn.addEventListener('click',function(){
      fetch('/api/auth/logout',{method:'POST'}).then(function(){window.location.href='/'}).catch(function(){window.location.href='/'});
    });
  }
  var exportBtn=document.getElementById('export-btn');
  var deleteBtn=document.getElementById('delete-btn');
  var actionMsg=document.getElementById('account-action-msg');
  if(exportBtn){
    exportBtn.addEventListener('click',function(){
      if(actionMsg)actionMsg.textContent='Exporting data...';
      fetch('/api/account/export')
        .then(function(r){return r.json()})
        .then(function(data){
          var blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
          var url=URL.createObjectURL(blob);
          var a=document.createElement('a');
          a.href=url;
          a.download='frank-account-export.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          if(actionMsg)actionMsg.textContent='Export complete.';
        })
        .catch(function(){
          if(actionMsg)actionMsg.textContent='Failed to export data.';
        });
    });
  }
  if(deleteBtn){
    deleteBtn.addEventListener('click',function(){
      if(!confirm('Are you sure you want to permanently delete your account and all saved search history? This cannot be undone.'))return;
      if(actionMsg)actionMsg.textContent='Deleting account...';
      fetch('/api/account/delete',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({confirm:'DELETE'})
      })
        .then(function(r){return r.json()})
        .then(function(d){
          if(d&&d.ok){
            window.location.href='/';
          }else{
            if(actionMsg)actionMsg.textContent=(d&&d.error)||'Failed to delete account.';
          }
        })
        .catch(function(){
          if(actionMsg)actionMsg.textContent='Network error. Try again.';
        });
    });
  }
  var el=document.getElementById('account-history-list');
  var raw=document.getElementById('account-history-data');
  if(el&&raw&&window.TrueRankHistory){
    try{
      var items=JSON.parse(raw.textContent||'[]');
      TrueRankHistory.render(el,{items:items,emptyMessage:'No searches yet. Run a research query from the home page and it will show up here.'});
    }catch(e){}
  }
})();
</script>`;

export async function renderAccountPage(request, env) {
    const user = await getSessionUser(request, env);
    if (!user) {
        return Response.redirect(new URL('/login', request.url).toString(), 302);
    }
    const searches = await getUserSearches(env.DB, user.id, 50);
    const historyJson = JSON.stringify(
        searches
            .filter((s) => s.slug)
            .map((s) => ({
                slug: s.slug,
                query: displayQuery(s.query),
                ts: s.created_at * 1000,
            })),
    ).replace(/</g, '\\u003c');

    const body = `<div class="grid-bg border-b border-line">
<div class="container mx-auto max-w-5xl px-6 py-16">
<div class="flex flex-wrap items-start justify-between gap-4">
<div>
<p class="font-mono text-[11px] uppercase tracking-widest text-ink-3">Session &middot; Signed in</p>
<h1 class="mt-2 font-serif text-h1 font-semibold text-ink">Your research</h1>
<p class="mt-2 font-mono text-xs text-ink-2">${escapeHtml(user.email)}</p>
</div>
<button id="logout-btn" type="button" class="border border-line bg-surface-1 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink transition-colors hover:border-ink-3">Sign out</button>
</div>
</div>
</div>
<div class="container mx-auto max-w-5xl px-6 py-10">
<script type="application/json" id="account-history-data">${historyJson}</script>
<div id="account-history-list" aria-live="polite"></div>
<div class="mt-12 border-t border-line pt-8">
<h2 class="font-mono text-xs font-semibold uppercase tracking-widest text-ink-3">Manage Account</h2>
<div class="mt-4 flex flex-wrap gap-4">
<button id="export-btn" type="button" class="border border-line bg-surface-1 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink hover:border-line-strong">Export my data</button>
<button id="delete-btn" type="button" class="border border-trust-low bg-trust-low-bg px-4 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-trust-low hover:bg-trust-low hover:text-white">Delete account</button>
</div>
<p id="account-action-msg" role="status" aria-live="polite" class="mt-2 min-h-[1.25rem] font-mono text-xs text-ink-3"></p>
</div>
</div>`;
    return layout('Your research', 'Your past Frank searches.', body, '<meta name="robots" content="noindex, follow">' + ACCOUNT_PAGE_SCRIPT, { canonical: 'https://chrisputer.tech/account' });
}
