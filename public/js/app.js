/**
 * Frank frontend - theme toggle, example queries, and the live research
 * flow (submit -> queue -> SSE progress -> redirect). Reports are rendered
 * server-side at /research/:slug; on completion we always navigate there.
 */
(function () {
    'use strict';

    // -- Theme toggle (bootstrap that sets the initial class runs inline in
    //    <head> before paint; here we only wire the toggle button). ----------
    var themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        syncIcons(document.documentElement.classList.contains('dark'));
        themeToggle.addEventListener('click', function () {
            var isDark = document.documentElement.classList.toggle('dark');
            localStorage.setItem('theme', isDark ? 'dark' : 'light');
            syncIcons(isDark);
        });
    }

    function syncIcons(isDark) {
        var moon = document.getElementById('icon-moon');
        var sun = document.getElementById('icon-sun');
        if (moon && sun) {
            moon.classList.toggle('hidden', !isDark);
            sun.classList.toggle('hidden', isDark);
        }
    }

    // -- Example queries: fill the research box only, never start a run ----
    document.querySelectorAll('.example-query').forEach(function (btn) {
        btn.addEventListener('click', function () {
            var input = document.getElementById('query-input');
            if (!input) return;
            input.value = btn.dataset.query || '';
            input.focus();
        });
    });

    // -- Deep-link prefill: /?q=... fills the search box (used by guides) --
    (function () {
        try {
            var preset = new URLSearchParams(window.location.search).get('q');
            if (preset && preset.length >= 3) {
                var qi = document.getElementById('query-input');
                if (qi) { qi.value = preset.slice(0, 500); qi.focus(); }
            }
        } catch (e) { /* ignore */ }
    })();

    // -- Search form ------------------------------------------------------
    var searchForms = document.querySelectorAll('form.search-form');
    searchForms.forEach(function (form) {
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var input = form.querySelector('input[name="query"]');
            var query = (input && input.value || '').trim();
            if (query.length < 3) return;
            beginResearch(query);
        });
    });

    // -- Verify forms (hero + final call to action): POST /api/verify, then
    //    open /verify/<slug>. A saved verdict comes back with the same slug,
    //    so it opens at once. Without JavaScript the form GETs /verify.
    var VERIFY_NETWORK_ERROR = 'Could not reach Frank. Please try again.';
    var VERIFY_BUSY_LABEL = 'Checking…';

    ['verify-hero', 'verify-cta'].forEach(function (prefix) {
        var form = document.getElementById(prefix + '-form');
        if (form) wireVerifyForm(form, document.getElementById(prefix + '-status'));
    });

    function wireVerifyForm(form, status) {
        var input = form.querySelector('input[name="product"]');
        var btn = form.querySelector('button[type="submit"]');
        var idleLabel = btn ? btn.textContent : '';
        var busy = false;

        function setBusy(on) {
            busy = on;
            if (!btn) return;
            btn.disabled = on;
            btn.textContent = on ? VERIFY_BUSY_LABEL : idleLabel;
        }

        // Back restores this page from bfcache with the button still busy.
        window.addEventListener('pageshow', function () {
            if (busy) setBusy(false);
        });

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var product = (input && input.value || '').trim();
            if (product.length < 3 || busy) return;
            setBusy(true);
            showVerifyStatus(status, '', false);
            fetch('/api/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ product: product }),
            })
                .then(function (res) { return res.json(); })
                .then(function (data) {
                    if (data && data.slug) {
                        window.location.href = '/verify/' + encodeURIComponent(data.slug);
                        return;
                    }
                    var message = (data && data.error) || VERIFY_NETWORK_ERROR;
                    showVerifyStatus(status, message, data && data.code === 'signup_required');
                    setBusy(false);
                })
                .catch(function () {
                    showVerifyStatus(status, VERIFY_NETWORK_ERROR, false);
                    setBusy(false);
                });
        });
    }

    // Text only: server text never reaches innerHTML. The /account link is
    // built with DOM APIs.
    function showVerifyStatus(status, message, signupRequired) {
        if (!status) return;
        status.textContent = message;
        if (!signupRequired) return;
        var link = document.createElement('a');
        link.href = '/account';
        link.className = 'font-medium text-accent hover:text-accent-hover';
        link.textContent = 'Create a free account';
        status.appendChild(document.createTextNode(' '));
        status.appendChild(link);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    // Generic clarifiers shown when /api/classify fails or returns none, so the
    // "get it right the first time" step ALWAYS appears. Mirrors the server's
    // defaultQuestionsForQuery (lib/classifier.js). All optional + skippable.
    var DEFAULT_QUESTIONS = [
        {
            key: 'priority',
            question: 'What matters most to you?',
            suggested_answers: ['Best overall quality', 'Best value for money', 'Easiest to use', 'Most durable'],
        },
        {
            key: 'budget',
            question: 'What’s your budget?',
            suggested_answers: ['Under $50', '$50–150', '$150–300', '$300+', 'No strict budget'],
        },
    ];

    // Inquisitive step: classify the query first, then ALWAYS show clarifying
    // questions (the classifier returns at least one; if it errors or returns
    // none we fall back to DEFAULT_QUESTIONS) with a one-tap "Just search for
    // it" skip. Reject messages still short-circuit. Research is never blocked.
    // Guards against rapid double-submits / example-chip taps queuing duplicate
    // /api/classify calls. Reset in setFormsBusy(false) (the error/return path);
    // a successful run redirects away, so no reset is needed there.
    var inFlight = false;
    function beginResearch(query) {
        if (inFlight) return;
        inFlight = true;
        setFormsBusy(true);
        fetch('/api/classify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query }),
        })
            .then(readJson)
            .then(function (data) {
                if (data && data.accept === false && data.reject_message) { showError(data.reject_message); return; }
                var qs = (data && data.clarifying_questions) || [];
                renderClarify(query, qs.length > 0 ? qs : DEFAULT_QUESTIONS);
            })
            .catch(function () { renderClarify(query, DEFAULT_QUESTIONS); }); // fail-open, but still ask
    }

    function renderClarify(query, questions) {
        var sec = document.getElementById('clarify-section');
        if (!sec) { startResearch(query, null); return; }
        var h = '<div class="mx-auto max-w-2xl rounded-xl border border-line bg-surface-1 p-6 shadow-card text-left">';
        h += '<h2 class="font-serif text-h3 font-semibold text-ink mb-1">A couple quick questions</h2>';
        h += '<p class="text-body-sm text-ink-3 mb-5">Optional — pick an answer or type your own, or skip and search as-is.</p>';
        h += '<form id="clarify-inline-form">';
        questions.forEach(function (q, i) {
            h += '<fieldset class="clarify-q mb-4 border-0 p-0" data-qkey="' + esc(q.key) + '"><legend class="font-sans text-body-sm font-semibold text-ink mb-2">' + esc(q.question) + '</legend><div class="chip-row flex flex-wrap gap-2 mb-2">';
            (q.suggested_answers || []).forEach(function (a, j) {
                var id = 'cq' + i + '_' + j;
                h += '<label class="chip" for="' + id + '"><input type="radio" id="' + id + '" name="q_' + esc(q.key) + '" value="' + esc(a) + '" data-chip><span>' + esc(a) + '</span></label>';
            });
            h += '</div><input type="text" name="q_' + esc(q.key) + '_custom" placeholder="Or type your own answer" maxlength="80" data-custom aria-label="' + esc(q.question) + ' — custom answer" class="w-full rounded-lg border border-line bg-bg px-3 py-2 font-sans text-body-sm text-ink placeholder:text-ink-3 focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-accent/25"></fieldset>';
        });
        h += '<div class="flex flex-wrap gap-2 mt-5">';
        h += '<button type="submit" class="inline-flex flex-1 items-center justify-center rounded-lg bg-accent-strong px-4 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-accent-hover" style="min-width:9rem">Run research</button>';
        h += '<button type="button" data-skip class="inline-flex items-center justify-center rounded-lg border border-line bg-surface-1 px-4 py-2 text-body-sm font-semibold text-ink transition-colors hover:bg-surface-2">Just search for it</button>';
        h += '</div></form></div>';
        sec.innerHTML = h;
        showSection('clarify');
        scrollToEl(sec);
        var form = document.getElementById('clarify-inline-form');
        form.querySelectorAll('fieldset').forEach(function (fs) {
            var custom = fs.querySelector('input[data-custom]');
            if (!custom) return;
            custom.addEventListener('input', function () {
                if (custom.value.trim().length > 0) {
                    fs.querySelectorAll('input[data-chip]').forEach(function (r) { r.checked = false; });
                }
            });
            fs.querySelectorAll('input[data-chip]').forEach(function (r) {
                r.addEventListener('change', function () {
                    if (r.checked && custom.value.trim().length > 0) custom.value = '';
                });
            });
        });
        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var clar = {};
            questions.forEach(function (q) {
                var custom = form.querySelector('input[name="q_' + (window.CSS && CSS.escape ? CSS.escape(q.key) : q.key) + '_custom"]');
                var customVal = custom && custom.value.trim();
                if (customVal) { clar[q.key] = customVal.slice(0, 80); return; }
                var sel = form.querySelector('input[name="q_' + (window.CSS && CSS.escape ? CSS.escape(q.key) : q.key) + '"]:checked');
                if (sel) clar[q.key] = sel.value;
            });
            startResearch(query, clar);
        });
        var skip = form.querySelector('[data-skip]');
        if (skip) skip.addEventListener('click', function () { startResearch(query, null); });
    }

    function recordHistory(slug, query) {
        if (window.TrueRankHistory && slug && query) {
            TrueRankHistory.record(slug, query);
        }
    }

    function setFormsBusy(busy) {
        if (!busy) inFlight = false; // re-enable submission after an error/return
        searchForms.forEach(function (form) {
            var btn = form.querySelector('button[type="submit"]');
            var input = form.querySelector('input[name="query"]');
            if (input) input.disabled = busy;
            if (btn) {
                btn.disabled = busy;
                var label = btn.querySelector('[data-btn-label]');
                if (label) label.textContent = busy ? 'Researching…' : 'Research it';
            }
        });
    }

    // Parse a response as JSON, but fail CLEARLY when the body isn't JSON. A
    // Cloudflare challenge/error page, an edge 5xx, or a rate-limit block all come
    // back as HTML — calling res.json() on those throws a cryptic
    // "Unexpected token '<'". We detect that up front and raise an actionable,
    // already-friendly message instead.
    function readJson(res) {
        var ct = (res.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('application/json') !== -1) return res.json();
        return res.text().then(function () {
            var e = new Error(
                res.status === 429
                    ? 'Too many requests right now. Please wait a minute and try again.'
                    : res.status >= 500
                        ? 'The server is briefly busy. Please try again in a moment.'
                        : 'The request was interrupted (a security check or network hiccup). Please refresh and try again.'
            );
            e.handled = true; // message is already user-ready
            throw e;
        });
    }

    // Turn any thrown error into something a human can act on.
    function friendlyError(err, fallback) {
        var m = (err && err.message) || '';
        if (err && err.handled) return m;
        if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) {
            return 'Couldn’t reach the server. Check your connection and try again.';
        }
        if (/Unexpected token|JSON|DOCTYPE/i.test(m)) {
            return 'The server returned an unexpected response. Please try again in a moment.';
        }
        return fallback + (m ? ' (' + m + ')' : '');
    }

    // -- Live research completion state ------------------------------------
    // Shared across SSE + polling for a single in-flight run so whichever
    // detects the terminal state first wins and the other becomes a no-op.
    var researchDone = false;
    var pollActive = false;
    var visibilityWatchdog = null;

    function finishResearch(dest, query) {
        if (researchDone) return;
        researchDone = true;
        recordHistory(dest, query || '');
        addProgress('Done. Opening your report…');
        window.location.href = '/research/' + dest;
    }

    function startResearch(query, clarifications) {
        researchDone = false;
        pollActive = false;
        if (visibilityWatchdog) {
            document.removeEventListener('visibilitychange', visibilityWatchdog);
            visibilityWatchdog = null;
        }

        setFormsBusy(true);
        showSection('progress');
        clearProgress();
        addProgress('Submitting your question…');
        scrollToEl(document.getElementById('progress-section'));

        var reqBody = { query: query };
        if (clarifications && Object.keys(clarifications).length) reqBody.clarifications = clarifications;
        var pendingQuery = query;
        fetch('/api/research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody),
        })
            .then(readJson)
            .then(function (data) {
                if (data.error) { showError(data.error, { signupRequired: data.code === 'signup_required' }); return; }
                if (data.cached && data.slug) {
                    researchDone = true;
                    recordHistory(data.slug, pendingQuery);
                    addProgress('Found existing research. Redirecting…');
                    window.location.href = '/research/' + data.slug;
                    return;
                }
                addProgress('Queued. Connecting to the live read…');
                connectSSE(data.id, data.slug, pendingQuery);
                // Independent watchdog: poll from the start regardless of SSE
                // health, so a stalled/backgrounded EventSource can never hang
                // the page on "processing…" forever.
                startPollWatchdog(data.id, data.slug, pendingQuery);
            })
            .catch(function (err) {
                showError(friendlyError(err, 'Could not start the research.'));
            });
    }

    function startPollWatchdog(reportId, slug, query) {
        if (pollActive) return;
        pollActive = true;
        pollForResults(reportId, 0, slug, query);

        visibilityWatchdog = function () {
            if (researchDone || document.visibilityState !== 'visible') return;
            pollForResults(reportId, 0, slug, query);
        };
        document.addEventListener('visibilitychange', visibilityWatchdog);
    }

    function connectSSE(reportId, slug, query) {
        var errorCount = 0;
        var source = new EventSource('/api/research/' + reportId + '/stream');

        source.onmessage = function (event) {
            errorCount = 0;
            var data;
            try { data = JSON.parse(event.data); } catch (e) { return; }

            if (data.type === 'progress') {
                addProgress(data.message);
            } else if (data.type === 'complete') {
                source.close();
                var dest = data.slug || slug;
                if (dest) {
                    finishResearch(dest, query);
                } else if (!researchDone) {
                    showError('Something went wrong — try again');
                }
            } else if (data.type === 'error') {
                source.close();
                if (!researchDone) showError(data.error);
            }
        };

        source.onerror = function () {
            if (researchDone) return;
            errorCount++;
            if (errorCount > 5) {
                source.close();
                addProgress('Connection unstable. Switching to polling…');
                startPollWatchdog(reportId, slug, query);
            }
        };
    }

    function pollForResults(reportId, attempts, slug, query) {
        if (researchDone) return;
        if (attempts > 120) { showError('Research timed out. Please try again.'); return; }
        fetch('/api/research/' + reportId)
            .then(readJson)
            .then(function (data) {
                if (researchDone) return;
                if (data.status === 'completed') {
                    var dest = data.slug || slug;
                    if (dest) {
                        finishResearch(dest, query);
                        return;
                    }
                    showError('Something went wrong — try again');
                } else if (data.status === 'error') {
                    showError(data.error || 'Research failed');
                } else {
                    if (data.progress) addProgress(data.progress.message);
                    setTimeout(function () { pollForResults(reportId, attempts + 1, slug, query); }, 2000);
                }
            })
            .catch(function () {
                if (researchDone) return;
                setTimeout(function () { pollForResults(reportId, attempts + 1, slug, query); }, 3000);
            });
    }

    // -- UI helpers -------------------------------------------------------

    // Scroll respecting prefers-reduced-motion (an explicit behavior:'smooth'
    // in scrollIntoView overrides the CSS scroll-behavior guard, so gate here).
    function scrollToEl(el) {
        if (!el || !el.scrollIntoView) return;
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }

    function showSection(name) {
        ['progress', 'error', 'clarify'].forEach(function (s) {
            var el = document.getElementById(s + '-section');
            if (el) el.classList.toggle('hidden', s !== name);
        });
        ['how-it-works', 'landing-extra'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.add('hidden');
        });
    }

    function clearProgress() {
        var log = document.getElementById('progress-log');
        if (log) log.innerHTML = '';
    }

    function addProgress(message) {
        var log = document.getElementById('progress-log');
        if (!log) return;
        var entry = document.createElement('div');
        entry.className = 'progress-entry animate-fade-in';
        entry.textContent = message;
        log.appendChild(entry);
        log.scrollTop = log.scrollHeight;
    }

    function showError(message, opts) {
        showSection('error');
        var el = document.getElementById('error-message');
        if (el) el.textContent = message || 'Something went wrong.';
        var cta = document.getElementById('error-signup-cta');
        if (cta) cta.classList.toggle('hidden', !(opts && opts.signupRequired));
        setFormsBusy(false);
    }

    // -- "Talk it out": chat-to-refine before running a research -----------
    (function () {
        var toggle = document.getElementById('talk-toggle');
        var section = document.getElementById('talk-section');
        var form = document.getElementById('talk-form');
        var input = document.getElementById('talk-input');
        var box = document.getElementById('talk-messages');
        var status = document.getElementById('talk-status');
        if (!toggle || !section || !form || !input || !box) return;

        var transcript = [];
        var busy = false;

        toggle.addEventListener('click', function () {
            var opening = section.classList.contains('hidden');
            section.classList.toggle('hidden');
            if (opening) {
                if (box.children.length === 0) {
                    bubble('assistant', "Tell me what you're trying to solve or buy — even vaguely — and I'll help you turn it into a researchable question.");
                }
                input.focus();
            }
        });

        function bubble(role, text) {
            var div = document.createElement('div');
            div.className = role === 'user'
                ? 'self-end max-w-[85%] rounded-lg bg-accent/15 px-3 py-2 text-body-sm text-ink whitespace-pre-wrap'
                : 'self-start max-w-[85%] rounded-lg bg-surface-2 px-3 py-2 text-body-sm text-ink-2 whitespace-pre-wrap';
            div.textContent = text;
            box.appendChild(div);
            box.scrollTop = box.scrollHeight;
            return div;
        }

        function suggestButton(query) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'self-start rounded-lg bg-accent-strong px-3 py-2 text-body-sm font-semibold text-white transition-colors hover:bg-accent-hover';
            btn.textContent = 'Research: ' + query;
            btn.addEventListener('click', function () {
                var qi = document.getElementById('query-input');
                if (qi) qi.value = query;
                section.classList.add('hidden');
                beginResearch(query);
            });
            box.appendChild(btn);
            box.scrollTop = box.scrollHeight;
        }

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var text = (input.value || '').trim();
            if (!text || busy) return;
            busy = true;
            input.value = '';
            if (transcript.length >= 14) transcript = transcript.slice(transcript.length - 13);
            transcript.push({ role: 'user', content: text });
            bubble('user', text);
            var thinking = bubble('assistant', '…');
            if (status) status.textContent = '';

            fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: transcript }),
            })
                .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
                .then(function (res) {
                    busy = false;
                    if (res.ok && res.d && res.d.reply) {
                        thinking.textContent = res.d.reply;
                        transcript.push({ role: 'assistant', content: res.d.reply });
                        if (res.d.suggestedQuery) suggestButton(res.d.suggestedQuery);
                    } else {
                        thinking.remove();
                        transcript.pop();
                        if (status) status.textContent = (res.d && res.d.error) || 'Something went wrong. Try again.';
                    }
                })
                .catch(function () {
                    busy = false;
                    thinking.remove();
                    transcript.pop();
                    if (status) status.textContent = 'Network error. Try again.';
                });
        });
    })();

    // Home tabs: New search | Your searches
    (function () {
        var tabs = document.querySelectorAll('[data-home-tab]');
        var searchPanel = document.getElementById('home-search-panel');
        var historyPanel = document.getElementById('home-history-panel');
        if (!tabs.length || !searchPanel || !historyPanel) return;

        function showTab(name) {
            var isSearch = name === 'search';
            searchPanel.classList.toggle('hidden', !isSearch);
            historyPanel.classList.toggle('hidden', isSearch);
            tabs.forEach(function (tab) {
                var active = tab.dataset.homeTab === name;
                tab.setAttribute('aria-selected', active ? 'true' : 'false');
                tab.setAttribute('tabindex', active ? '0' : '-1');
                tab.classList.toggle('bg-accent-quiet', active);
                tab.classList.toggle('text-ink', active);
                tab.classList.toggle('text-ink-3', !active);
            });
            if (!isSearch && window.TrueRankHistory) {
                TrueRankHistory.render(document.getElementById('home-history-list'));
            }
        }

        tabs.forEach(function (tab, i) {
            tab.setAttribute('tabindex', tab.getAttribute('aria-selected') === 'true' ? '0' : '-1');
            tab.addEventListener('click', function () { showTab(tab.dataset.homeTab); });
            tab.addEventListener('keydown', function (ev) {
                var next = i;
                if (ev.key === 'ArrowRight') next = (i + 1) % tabs.length;
                else if (ev.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
                else if (ev.key === 'Home') next = 0;
                else if (ev.key === 'End') next = tabs.length - 1;
                else return;
                ev.preventDefault();
                showTab(tabs[next].dataset.homeTab);
                tabs[next].focus();
            });
        });
    })();

    // Expose reset for the "Try again" button.
    window.resetUI = function () {
        showSection('none');
        ['how-it-works', 'landing-extra'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.classList.remove('hidden');
        });
        setFormsBusy(false);
        scrollToEl(document.getElementById('hero'));
    };
})();
