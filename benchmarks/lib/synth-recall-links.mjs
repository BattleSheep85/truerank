// synth-recall-links.mjs — CP-406: two deterministic synth-bench metrics the
// 2026-06-17 honesty audit deferred. Pure, no I/O, no LLM.
//
//   legitRecall      catches the synth DROPPING the credible picks (the audit
//                    saw kimi do this on 6/6 scenarios; legit_top_rank alone
//                    cannot see a pick that vanished).
//   linkCorrectness  catches a TRAP URL attached to another product (the audit
//                    saw the trap's affiliate listicle cited as a legit pick's
//                    productUrl).
//
// A scenario is the synth-fixture shape: { trap, legit: [names], sources: [{url,
// title, content}] }.

const LINK_FIELDS = ['productUrl', 'manufacturerUrl'];

const squash = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const round3 = (n) => Math.round(n * 1000) / 1000;
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Kit (ConvertKit)" is one pick known by two names.
function aliases(target) {
  const full = squash(target);
  const m = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  return (m ? [full, squash(m[1]), squash(m[2])] : [full]).filter(Boolean);
}

// Whole-word match, so "Kit" is not "Toolkit" and "Keychron V1" is not
// "Keychron V10". A blank target matches nothing.
export function nameMatches(text, target) {
  const hay = squash(text);
  return aliases(target).some((a) => new RegExp(`(?:^|[^a-z0-9])${reEscape(a)}(?:$|[^a-z0-9])`).test(hay));
}

// The trap product never counts as a kept legit pick, even if its name holds
// a legit alias ("MailRocket Pro Starter Kit").
export function legitRecall(productNames, legit, trap = '') {
  const list = Array.isArray(legit) ? legit : [];
  if (!list.length) return { recall: null, kept: [], missing: [] };
  const names = (productNames || []).filter((n) => !nameMatches(n, trap));
  const kept = list.filter((L) => names.some((n) => nameMatches(n, L)));
  const missing = list.filter((L) => !kept.includes(L));
  return { recall: round3(kept.length / list.length), kept, missing };
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// A trap source names the trap and no legit pick: the affiliate listicle and
// the trap's own store. A roundup that names both is a fair source for either.
export function trapSourceHosts(scenario) {
  const hosts = [];
  for (const s of scenario?.sources || []) {
    const text = `${s.title || ''} ${s.content || ''}`;
    if (!nameMatches(text, scenario.trap)) continue;
    if ((scenario.legit || []).some((L) => nameMatches(text, L))) continue;
    const host = hostOf(s.url);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

// Every non-empty link on a non-trap product is checked. A link is wrong when
// it points at a trap source host, or cannot be parsed as a URL at all.
export function linkCorrectness(products, scenario) {
  const trapHosts = trapSourceHosts(scenario);
  const wrongList = [];
  let checked = 0;
  for (const p of Array.isArray(products) ? products : []) {
    if (nameMatches(p?.name, scenario.trap)) continue;
    for (const field of LINK_FIELDS) {
      const url = typeof p?.[field] === 'string' ? p[field].trim() : '';
      if (!url) continue;
      checked++;
      const host = hostOf(url);
      if (!host || trapHosts.includes(host)) wrongList.push({ product: p.name, field, url });
    }
  }
  const wrong = wrongList.length;
  return { checked, wrong, rate: checked ? round3((checked - wrong) / checked) : null, wrongList };
}
