// Coverage for the pure helpers in llm.js: the reasoning-effort time budgets and
// the context-pruning algorithm (truncate middle tool outputs, then drop oldest).
import { llmBudgetMs, pruneMessages, sanitizeLLMMessages } from '../../worker/engine/llm.js';

export function runLlmTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // llmBudgetMs — all four branches.
  eq('budget high', llmBudgetMs('high').hardMs, 360_000);
  eq('budget medium', llmBudgetMs('medium').hardMs, 240_000);
  eq('budget low', llmBudgetMs('low').hardMs, 180_000);
  eq('budget default', llmBudgetMs(undefined).hardMs, 120_000);

  // sanitizeLLMMessages — strips unpaired UTF-16 surrogates (the OpenRouter 400
  // "Invalid input … unpaired UTF-16 surrogate" cause) while preserving valid text
  // and valid emoji (a full surrogate PAIR must survive).
  {
    const loneHigh = 'good backpack \uD83D and more'; // lone high surrogate
    const loneLow = 'nice \uDE00 pick';                // lone low surrogate
    const validEmoji = 'love it 😀 great';   // full pair 😀
    const out = sanitizeLLMMessages([
      { role: 'user', content: loneHigh },
      { role: 'system', content: loneLow },
      { role: 'assistant', content: validEmoji },
      { role: 'tool', content: 42 }, // non-string content passes through
    ]);
    ok('lone high surrogate removed', !/[\uD800-\uDBFF]/.test(out[0].content) && out[0].content.includes('good backpack'));
    ok('lone low surrogate removed', !/[\uDC00-\uDFFF]/.test(out[1].content) && out[1].content.includes('nice'));
    eq('valid emoji pair preserved', out[2].content, validEmoji);
    eq('non-string content untouched', out[3].content, 42);
    // JSON of the cleaned strings must be valid UTF-8 (no lone surrogates anywhere).
    ok('no lone surrogates remain across all', !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out.map((m) => m.content).join('')));
  }
  eq('sanitize non-array passthrough', sanitizeLLMMessages(null), null);

  // pruneMessages — under budget → returned unchanged (same reference).
  {
    const msgs = [{ role: 'system', content: 'a' }, { role: 'user', content: 'b' }];
    ok('prune: under budget unchanged', pruneMessages(msgs) === msgs);
  }

  // Over budget but <= KEEP_HEAD+KEEP_TAIL (12) messages → can't prune, unchanged.
  {
    const msgs = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: 'x'.repeat(11_000) + i }));
    ok('prune: too few messages to prune → unchanged', pruneMessages(msgs) === msgs);
  }

  // Over budget with >12 messages: middle tool outputs truncated, then oldest
  // middle dropped while still over (huge un-truncatable head forces the drop loop).
  {
    const head = [{ role: 'system', content: 'h'.repeat(70_000) }, { role: 'user', content: 'h'.repeat(70_000) }];
    const middle = Array.from({ length: 4 }, (_, i) => ({ role: 'tool', content: 't'.repeat(1_000) + i }));
    const tail = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'tail' + i }));
    const out = pruneMessages([...head, ...middle, ...tail]);
    ok('prune: returns a new array', Array.isArray(out));
    ok('prune: keeps head', out[0].content.length === 70_000);
    ok('prune: keeps the 10-message tail', out.slice(-10).every((m) => m.content.startsWith('tail')));
    ok('prune: dropped/truncated the middle tool spam', out.length < 2 + 4 + 10);
  }

  // pruneMessages opts — explicit defaults match the no-opts call.
  {
    const head = [{ role: 'system', content: 'h'.repeat(70_000) }, { role: 'user', content: 'h'.repeat(70_000) }];
    const middle = Array.from({ length: 4 }, (_, i) => ({ role: 'tool', content: 't'.repeat(1_000) + i }));
    const tail = Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: 'tail' + i }));
    const msgs = [...head, ...middle, ...tail];
    eq('prune opts: explicit defaults equal no-opts', pruneMessages(msgs, { maxChars: 120_000, keepTail: 10, middleToolTruncate: 200 }), pruneMessages(msgs));
    eq('prune opts: empty opts equal no-opts', pruneMessages(msgs, {}), pruneMessages(msgs));
  }

  // pruneMessages opts.maxChars — a lower budget prunes what the default keeps.
  {
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: 'tool', content: 'x'.repeat(4_000) + i }));
    ok('prune opts: 80k under default budget → unchanged', pruneMessages(msgs) === msgs);
    const out = pruneMessages(msgs, { maxChars: 60_000 });
    ok('prune opts: maxChars 60k → new array', out !== msgs);
    ok('prune opts: maxChars 60k → result under budget', out.reduce((n, m) => n + m.content.length, 0) <= 60_000);
    ok('prune opts: maxChars 60k keeps head', out[0] === msgs[0] && out[1] === msgs[1]);
    ok('prune opts: maxChars 60k keeps the 10-message tail', out.slice(-10).every((m, i) => m === msgs[10 + i]));
    eq('prune opts: input not mutated', msgs[5].content.length, 4_000 + 1);
  }

  // pruneMessages opts.keepTail — a shorter tail lets more of the middle be pruned.
  {
    const msgs = Array.from({ length: 14 }, (_, i) => ({ role: 'tool', content: 'y'.repeat(10_000) + i }));
    ok('prune opts: 14 msgs, default keepTail 10 → middle still pruned', pruneMessages(msgs, { maxChars: 70_000 }).length < 14);
    const out = pruneMessages(msgs, { maxChars: 70_000, keepTail: 4 });
    ok('prune opts: keepTail 4 keeps last 4 intact', out.slice(-4).every((m, i) => m === msgs[10 + i]));
    ok('prune opts: keepTail 4 truncates middle tool output', out.slice(2, -4).every((m) => m.content.length < 500));
    eq('prune opts: keepTail 4 keeps all 14 (truncation fits budget)', out.length, 14);
    const few = msgs.slice(0, 6);
    ok('prune opts: <= head+keepTail → unchanged', pruneMessages(few, { maxChars: 1, keepTail: 4 }) === few);
  }

  // pruneMessages opts.middleToolTruncate — sets the kept prefix of middle tool output.
  {
    const msgs = Array.from({ length: 14 }, (_, i) => ({ role: 'tool', content: 'z'.repeat(10_000) + i }));
    const out = pruneMessages(msgs, { maxChars: 70_000, keepTail: 4, middleToolTruncate: 50 });
    ok('prune opts: middleToolTruncate 50 → 50-char prefix', out[2].content.startsWith('z'.repeat(50) + '\n[...truncated'));
    const def = pruneMessages(msgs, { maxChars: 70_000, keepTail: 4 });
    ok('prune opts: default middleToolTruncate 200', def[2].content.startsWith('z'.repeat(200) + '\n[...truncated'));
  }

  return report;
}
