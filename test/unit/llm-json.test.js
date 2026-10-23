// Full-coverage assertions for the single fenced-JSON parser shared across
// every "LLM returned JSON, maybe fenced, maybe prose-wrapped" call site.
import { parseFencedJson } from '../../worker/lib/llm-json.js';

// Lines the parser logs while `fn` runs (console.warn), and fn's result.
function warnLines(fn) {
  const lines = [];
  const saved = console.warn;
  console.warn = (...args) => lines.push(args.join(' '));
  try { return { value: fn(), lines }; } finally { console.warn = saved; }
}

export function runLlmJsonTests() {
  const report = { passed: 0, failed: 0, failures: [] };
  const saved = console.warn;
  console.warn = () => {};
  try { return runCases(report); } finally { console.warn = saved; }
}

function runCases(report) {
  const eq = (name, a, e) => {
    const A = JSON.stringify(a), E = JSON.stringify(e);
    if (A === E) report.passed++; else { report.failed++; report.failures.push(`${name}: expected ${E}, got ${A}`); }
  };
  const ok = (name, c) => eq(name, !!c, true);

  // Rule 1: a non-null object/array already parsed (e.g. json_schema mode)
  // passes through UNCHANGED, as the same reference, not a structural copy.
  const obj = { a: 1 };
  ok('object passthrough same reference', parseFencedJson(obj) === obj);
  const arr = [1, 2, 3];
  ok('array (object) passthrough same reference', parseFencedJson(arr) === arr);

  // Rule 2: any other non-string input → null.
  eq('null input → null', parseFencedJson(null), null);
  eq('undefined input → null', parseFencedJson(undefined), null);
  eq('number input → null', parseFencedJson(42), null);
  eq('boolean input → null', parseFencedJson(true), null);

  // Rule 3+4: no fence, direct JSON.parse.
  eq('plain object json', parseFencedJson('{"a":1}'), { a: 1 });
  eq('plain array json (string form)', parseFencedJson('[1,2,3]'), [1, 2, 3]);

  // json-tagged and bare fences.
  eq('json fence', parseFencedJson('```json\n{"a":1}\n```'), { a: 1 });
  eq('bare fence (no json tag)', parseFencedJson('```\n{"b":2}\n```'), { b: 2 });
  eq('fenced array', parseFencedJson('```json\n[1,2,3]\n```'), [1, 2, 3]);

  // Whitespace tolerance around plain JSON and inside a fence.
  eq('leading/trailing whitespace', parseFencedJson('   {"a":1}   '), { a: 1 });
  eq('whitespace inside fence', parseFencedJson('```json\n\n  {"a":1}  \n\n```'), { a: 1 });

  // Rule 5: balanced-brace fallback. Prose-wrapped JSON is recovered. This is
  // the LOAD-BEARING behavior for the classifier's fail-open path.
  eq('prose before the object', parseFencedJson('Sure, here is the JSON: {"a":1} — hope that helps!'), { a: 1 });
  eq('prose after the object', parseFencedJson('{"ok":true} Let me know if you need anything else.'), { ok: true });

  // Nested braces inside a string value must not confuse the brace scan.
  const nested = '{"a": "text with { and } inside", "b": 2}';
  eq('nested braces inside a string (direct parse)', parseFencedJson(nested), { a: 'text with { and } inside', b: 2 });
  eq('nested braces inside a string (brace-scan fallback)', parseFencedJson(`Here you go: ${nested} thanks!`), { a: 'text with { and } inside', b: 2 });

  // The brace scan is first-{ to last-}, not a real bracket matcher: two
  // separate objects in the same string slice to an invalid JSON blob → null.
  eq('two objects in one string → invalid slice → null', parseFencedJson('prefix {"a":1} middle {"b":2} suffix'), null);

  // Rule 6: truly unparseable → null.
  eq('no braces at all → null', parseFencedJson('not json at all'), null);
  eq('garbage inside braces → null', parseFencedJson('{not: valid, json}'), null);
  eq('empty string → null', parseFencedJson(''), null);
  eq('unclosed braces → null', parseFencedJson('{{{{{'), null);

  // Never throws, even on hostile/exotic inputs.
  let threw = false;
  try {
    parseFencedJson('{{{{{');
    parseFencedJson('```json\n{{{{{\n```');
    parseFencedJson(Symbol('x'));
    parseFencedJson('}{');
  } catch {
    threw = true;
  }
  ok('never throws on hostile input', !threw);

  // CP-819: a reply the parser drops is logged once, here, for every caller.
  // The line is short and holds no model text.
  {
    const bad = warnLines(() => parseFencedJson('secret model words, not json', 'recall-supplement'));
    eq('log: bad reply still null', bad.value, null);
    eq('log: one line for a bad reply', bad.lines.length, 1);
    ok('log: line names the parser and the caller', bad.lines[0]?.includes('[llm-json]') && bad.lines[0]?.includes('recall-supplement'));
    ok('log: line gives the reply length', bad.lines[0]?.includes('28 chars'));
    ok('log: no model text in the line', !bad.lines[0]?.includes('secret'));
    const scan = warnLines(() => parseFencedJson('prefix {"a":1} middle {"b":2} suffix'));
    eq('log: a failed brace scan logs one line, default caller', scan.lines.length, 1);
    ok('log: default caller is "model"', scan.lines[0]?.includes('model reply'));
    const empty = warnLines(() => parseFencedJson(undefined, 'classifier'));
    eq('log: a missing reply logs one line', empty.lines.length, 1);
    ok('log: a missing reply says so', empty.lines[0]?.includes('no reply'));
    eq('log: a good reply logs nothing', warnLines(() => parseFencedJson('{"a":1}', 'x')).lines.length, 0);
    eq('log: a prose-wrapped reply logs nothing', warnLines(() => parseFencedJson('Sure: {"a":1}', 'x')).lines.length, 0);
    eq('log: an object logs nothing', warnLines(() => parseFencedJson({ a: 1 }, 'x')).lines.length, 0);
  }

  return report;
}
