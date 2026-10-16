import { readFileSync } from 'node:fs';
import { verdictForClaim, overallVerdict } from '../worker/lib/verdict.js';
const rows = JSON.parse(readFileSync(new URL('./claims.json', import.meta.url)))[0].results;
const by = new Map();
for (const r of rows) {
  const ev = JSON.parse(r.evidence || '[]');
  const claim = { text: r.claim_text, type: r.claim_type };
  const v = verdictForClaim(claim, ev, { policy: 'verification' });
  const list = by.get(r.query) || { stored: r.overall_score, cvs: [], changed: 0 };
  list.cvs.push({ status: v.status, claimType: r.claim_type });
  if (v.status !== r.verdict) list.changed++;
  by.set(r.query, list);
}
for (const [q, l] of by) console.log(q.padEnd(42), String(l.stored).padStart(5), '->', String(overallVerdict(l.cvs).score).padStart(5), `changed=${l.changed}`);
