// Single fenced-JSON parser shared by every "LLM returned JSON, maybe fenced,
// maybe prose-wrapped" call site. Strict superset of the eight local copies it
// replaces (worker/lib/classifier.js, worker/engine/engine.js,
// worker/engine/parallel-engine.js, worker/engine/verify.js,
// worker/engine/extract/name-cleaner.js, worker/engine/extract/recall-supplement.js):
//   1. A non-null object (already parsed, e.g. from a json_schema response) is
//      returned unchanged.
//   2. Any other non-string input returns null.
//   3. A ```json ... ``` or bare ``` ... ``` fence is stripped, then trimmed.
//   4. JSON.parse. Success returns the parsed value.
//   5. On failure, a balanced-object fallback: parse the slice from the first
//      `{` to the last `}`. This recovers prose-wrapped JSON ("Sure, here is
//      the JSON: {...} let me know if you need anything else!") and is
//      LOAD-BEARING for the classifier's fail-open path. Do not drop it.
//   6. Otherwise return null. Never throws.
// Every null is logged once here (CP-819), so a caller that treats null as "no
// data" still leaves a trace. `source` names the caller in that line. The line
// holds the reply's length, never its text.
export function parseFencedJson(raw, source = 'model') {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return dropped(source, `no reply (${raw === null ? 'null' : typeof raw})`);

  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  try {
    return JSON.parse(text);
  } catch {
    // fall through to the balanced-object scan
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      // fall through to the log line
    }
  }
  return dropped(source, `reply is not JSON (${raw.length} chars)`);
}

function dropped(source, why) {
  console.warn(`[llm-json] ${String(source)} ${why}, dropped`);
  return null;
}
