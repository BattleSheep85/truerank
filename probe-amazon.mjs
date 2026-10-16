import { readFocusedPage, harvestBuyerReviews } from './worker/engine/verify-resolve.js';
import { fetchPageContent } from './worker/lib/jina.js';
import { readFileSync } from 'node:fs';
const key = readFileSync('.dev.vars','utf8').match(/^JINA_API_KEY=(.*)$/m)[1].trim();
const url = process.argv[2];
const t0 = Date.now();
const [focused, shared] = await Promise.all([readFocusedPage(url, fetch, key), fetchPageContent(url, key)]);
console.log('focused', focused.length, 'buyerLines', (focused.match(/\[Buyer review\]/g)||[]).length, Date.now()-t0);
console.log('shared', shared.length);
for (const [name, content] of [['focused', focused], ['shared', shared]]) {
  const h = harvestBuyerReviews([{ url, title: 'Antec C8', content }], 'Antec C8');
  console.log(name, 'harvest', h.map((s) => s.reviewCount));
}
console.log(shared.slice(0, 300));
const i = shared.search(/customer reviews|out of 5 stars/i); console.log('review idx', i, shared.slice(i, i+800));
