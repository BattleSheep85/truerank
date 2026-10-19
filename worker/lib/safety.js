// Deterministic content-safety screen. FAIL-CLOSED: clear adult/illegal queries
// and scanner/probe payloads are blocked here BEFORE any research happens, independent
// of (and ahead of) the LLM classifier — which is fail-open and jailbreakable.
// This protects brand safety (AdSense + Amazon Associates ToS), SEO/reputation,
// spend protection, and legal exposure. The LLM classifier remains a second layer
// for subtler/obfuscated cases.
//
// CURATION RULE: prefer PHRASES and \b word-boundaries over bare substrings, so legitimate
// product research is never blocked. Bare anatomy/ambiguous words (nude, breast, gun, drug,
// weed, acid, crack, anal, escort, meth-as-substring) are DELIBERATELY not matched alone —
// only in unambiguous sexual/illegal phrasing. The allow-list test set guards this.

const ADULT_PATTERNS = [
  /\bporn\b/, /\bporno\b/, /pornhub|xvideos|xhamster|xnxx|youporn|redtube|brazzers/, /\bhentai\b/, /\brule\s?34\b/,
  /\bnsfw\b/, /\bxxx\b/,
  /\bsex\s?(?:toys?|dolls?|cams?|chat|shop|tape|video|videos|work|worker|workers)\b/, /\bsexting\b/,
  /\b(?:dildos?|fleshlight|buttplug|butt\s?plug|vibrators?\s+for\s+(?:women|men|adults))\b/,
  /\b(?:blowjob|handjob|cumshot|creampie|gangbang|bukkake|deepthroat|fellatio|cunnilingus)\b/,
  /\banal\s+(?:sex|porn)\b/, /\boral\s+sex\b/, /\bmasturbat/, /\bfetish\b/, /\bbdsm\b/, /\bmilf\b/,
  /\bescort\s+(?:service|services|agency|girl|girls)\b/, /\bescorts?\s+near\b/, /\bhire\s+an?\s+escort\b/,
  /\b(?:prostitut|brothel|hooker|callgirl|call\s?girl|camgirl|cam\s?girl)\b/,
  /\b(?:rub\s?and\s?tug|happy\s+ending\s+massage)\b/,
  /\b(?:onlyfans|strip\s?club|stripper|strippers|live\s+sex|webcam\s+girl)\b/,
  // NB: bare "nude"/"nudes" is NOT matched — it's a beauty/fashion color ("nude lipstick",
  // "nude heels"). Only explicit phrasing.
  /\b(?:naked\s+(?:women|men|girls|guys|pics|photos)|leaked\s+nudes?|send\s+nudes?)\b/, /\bnude\s+(?:photos?|pics|videos?)\b/,
  /\b(?:adult|porn|xxx)\s+(?:video|videos|film|films|movie|movies|site|sites|website|content|cam|cams)\b/,
];

// CP-803: drug-checking kits are harm-reduction products, so "fentanyl test strips" and
// "test strips for fentanyl" are research. The guards clear only a drug name that sits next
// to a kit; any other mention of the drug in the query still blocks.
const KIT = String.raw`(?:drug\s+)?(?:test|testing|detection)\s+(?:strips?|kits?)`;
const NOT_TEST_KIT = String.raw`(?!\s+${KIT})(?<!${KIT}\s+(?:for|to\s+detect)\s+\w+)`;
const HARD_DRUGS = String.raw`(?:cocaine|heroin|fentanyl|methamphetamine|crystal\s+meth)`;
const DRUG_NAMES = String.raw`(?:cocaine|heroin|meth|methamphetamine|fentanyl|mdma|ecstasy|lsd|crack\s+cocaine|crystal\s+meth|ketamine)`;

const ILLEGAL_PATTERNS = [
  // CSAM / exploitation — highest priority, broad block of the explicit signal.
  /\bchild\s+(?:porn|sex|sexual|abuse\s+material)\b/, /\bunderage\s+(?:porn|sex|girls?|boys?|nudes?)\b/,
  /\b(?:csam|cp\s+porn|pedophil|loli(?:con)?\b)/, /\bchild\s+exploitation\b/,
  // hard drugs — buying / making / specific substances.
  // CP-804: the test-kit exception applies only after "buy" and "where to buy".
  new RegExp(String.raw`\b(?:buy|where\s+to\s+buy)\s+(?:${DRUG_NAMES}\b${NOT_TEST_KIT}|illegal\s+drugs?\b)`),
  new RegExp(String.raw`\b(?:order|where\s+to\s+get|how\s+to\s+(?:make|get|cook))\s+(?:${DRUG_NAMES}|illegal\s+drugs?)\b`),
  new RegExp(String.raw`\b${HARD_DRUGS}\b${NOT_TEST_KIT}`), /\bcrack\s+cocaine\b/,
  /\bhow\s+to\s+make\s+(?:meth|drugs?|crack|crystal\s+meth)\b/, /\bbuy\s+drugs?\s+online\b/, /\bdark\s?web\s+drugs?\b/,
  // weapons — making / illegal acquisition (NOT legal firearm products).
  /\bhow\s+to\s+make\s+(?:a\s+)?(?:bomb|gun|silencer|suppressor|explosive|grenade|napalm|thermite|c4)\b/,
  /\b(?:pipe\s?bomb|ghost\s?gun|untraceable\s+gun|3d\s?printed?\s+gun|homemade\s+(?:gun|bomb|explosive))\b/,
  /\bbuy\s+(?:a\s+)?(?:gun|firearm|rifle|pistol)\s+(?:illegally|without\s+(?:a\s+)?(?:background|license|permit))\b/,
  /\b(?:buy|get)\s+(?:a\s+)?(?:machine\s?gun|automatic\s+weapon|grenade|explosives?|c4|dynamite)\b/,
  // hacking / fraud / theft.
  /\bhow\s+to\s+hack\b/, /\bhack\s+(?:someone|a\s+phone|an?\s+account|instagram|facebook|snapchat|wifi\s+password|into)\b/,
  /\b(?:steal|stolen)\s+(?:credit\s+card|credit\s+cards|cards?\s+number|identity|passwords?)\b/, /\bcredit\s+card\s+numbers\b/,
  /\b(?:carding|carder)\b/, /\b(?:fake|forged|novelty)\s+(?:id|ids|passport|passports|drivers?\s+licen[cs]e)\b/,
  /\bcounterfeit\s+(?:money|cash|currency|bills?)\b/, /\bhow\s+to\s+(?:make\s+)?counterfeit\b/,
  /\b(?:buy|sell)\s+stolen\s+(?:goods|credit|cards|data)\b/, /\b(?:phishing\s+kit|ransomware|keylogger|ddos\s+for\s+hire|stresser\s+service|booter\s+service)\b/,
  // piracy / counterfeit goods.
  /\b(?:pirated|cracked|nulled|warez)\s+(?:software|games?|movies?|apps?)\b/, /\b(?:keygen|crack\s+download|serial\s+keys?\s+for)\b/,
  /\b(?:replica|fake|counterfeit|knockoff)\s+(?:rolex|gucci|louis\s+vuitton|designer|watches|handbags?|sneakers)\b/,
  // trafficking.
  /\bhuman\s+trafficking\b/, /\bbuy\s+a\s+(?:human|kidney|organ)\b/,
  // CP-804: harm phrases. denylistForms joins spaced letters, so "make a b o m b",
  // "b o m b making" and "k i l l myself" reach these too. Bath bombs stay allowed.
  /\b(?:make|making|build|building)\s+(?:a\s+)?bombs?\b(?!\s+shelters?\b)/, /(?<!\bbath\s)\bbomb\s?making\b/,
  /\bkill(?:ing)?\s+(?:myself|my\s?self|yourself)\b/,
  // CP-808: "make an explosive" / "make explosives". Spaces are optional so joined
  // spaced letters ("makean explosive", "makeanexplosive") match too. The bare
  // adjective stays allowed: "build explosive power", "making explosive bass".
  /\b(?:make|making|build|building)\s?(?:an\s?explosive|(?:an?\s?)?explosives)\b/,
];

const SQL_PROBE_PATTERNS = [
  /\bunion\s+(?:all\s+)?select\b/i,
  /\bwaitfor\s+delay\b/i,
  /\bsleep\s*\(/i,
  /\bbenchmark\s*\(/i,
  /\butl_inaddr\b/i,
  /\bdbms_pipe\b/i,
  /\bxp_cmdshell\b/i,
  /\binformation_schema\b/i,
  // CP-803: error-based probes and boolean tautologies ("and 1=1", "' or 'a'='a").
  /\b(?:extractvalue|updatexml|load_file)\s*\(/i,
  /\b(?:and|or)\s+(['"]?)(\w+)\1\s*=\s*\1\2\1?(?!\w)/i,
  // A quote or paren glued to a SQL comment ("'--", "))--", "' /*"); "(2026) -- under" is prose.
  /['")](?:--|\s*\/\*)/,
];

const CODE_SCHEME_PATTERN = /\b(?:javascript|data)\s*:/i;
const HTML_TAG_PATTERN = /<\s*\/?\s*[a-z][a-z0-9_-]*(?:\s+[^>]*)?>/i;
const FULL_URL_PATTERN = /^\s*https?:\/\/\S+\s*$/i;
const SPECIAL_CHARS_PATTERN = /[(){}[\];|<>]/g;
const LONG_RUN_PATTERN = /[^\s]{25,}/;
// Alphanumeric run; rule 7 classifies each run once, so no token counts twice.
const ALNUM_RUN_PATTERN = /[a-zA-Z0-9]+/g;
// Model-number token: 2+ alnum chars with at least one letter and one digit ("C8", "A7", "M4").
const MODEL_TOKEN_PATTERN = /^(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)[a-z0-9]{2,}$/i;
const MIN_WORD_TOKEN_LENGTH = 3;
const MIN_QUERY_TOKENS = 2;

/**
 * Check if a query looks like code, a URL, a scanner probe, or an attack payload
 * rather than a genuine shopping question.
 *
 * Signals:
 * 1. SQL keywords in a suspicious shape (UNION SELECT, WAITFOR DELAY, SLEEP(, BENCHMARK(,
 *    UTL_INADDR, DBMS_PIPE, CHR( with concatenation, xp_cmdshell, information_schema,
 *    EXTRACTVALUE(, UPDATEXML(, LOAD_FILE(, "and 1=1" tautologies, a quote then -- or /*)
 * 2. script/HTML tags
 * 3. javascript: or data: schemes
 * 4. an http(s):// URL as the whole query (unless allowUrl: true)
 * 5. more than 3 of these characters `(){}[];|<>` combined
 * 6. a run of 25+ characters with no space
 * 7. nonsense ratio: no word token (3+ letters/digits, or a model number of 2+ chars with
 *    a letter and a digit, such as "C8"), or fewer than 2 tokens in all. Short tokens count
 *    toward the 2 once a word is present, so "buy a tv", "canon r 6" and "iphone 16" pass.
 *
 * @param {string} query
 * @param {{ allowUrl?: boolean }} [options]
 * @returns {boolean}
 */
export function isProbeQuery(query, options = {}) {
  if (typeof query !== 'string') return false;
  const raw = query.trim();
  if (!raw) return false;

  const isFullUrl = FULL_URL_PATTERN.test(raw);

  // 1. Whole URL
  if (isFullUrl && !options.allowUrl) return true;

  // 2. javascript: or data: schemes
  if (CODE_SCHEME_PATTERN.test(raw)) return true;

  // 3. HTML / script tags
  if (HTML_TAG_PATTERN.test(raw)) return true;

  // 4. SQL keywords in suspicious shapes
  for (const pat of SQL_PROBE_PATTERNS) {
    if (pat.test(raw)) return true;
  }
  // CHR( with concatenation (e.g. CHR(...) || or || CHR(...))
  if (
    /\bchr\s*\([^)]*\)\s*\|\|/i.test(raw) ||
    /\|\|\s*chr\s*\(/i.test(raw) ||
    (/\bchr\s*\(/i.test(raw) && /\|\||\+/.test(raw))
  ) {
    return true;
  }

  // 5. More than 3 of (){}[];|<> combined
  const specialMatches = raw.match(SPECIAL_CHARS_PATTERN);
  if (specialMatches && specialMatches.length > 3) return true;

  // When a full http(s) URL is explicitly allowed, skip the unbroken run
  // and token count checks that would otherwise flag standard URLs.
  if (isFullUrl && options.allowUrl) {
    return false;
  }

  // 6. Run of 25+ characters with no space
  if (LONG_RUN_PATTERN.test(raw)) return true;

  // 7. Nonsense ratio: no real word (3+ letters/digits, or a model number like "C8"),
  // or fewer than 2 tokens. A word plus short tokens ("sony a 7 iv", "tv stand") is a query.
  const runs = raw.match(ALNUM_RUN_PATTERN) || [];
  const hasWord = runs.some(isWordToken);
  if (!hasWord || runs.length < MIN_QUERY_TOKENS) return true;

  return false;
}

function isWordToken(run) {
  return run.length >= MIN_WORD_TOKEN_LENGTH || MODEL_TOKEN_PATTERN.test(run);
}

function normalize(query) {
  return ' ' + String(query || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

// CP-394: obfuscation folding. The denylist runs on the plain form AND on folded forms, so
// "p0rn", "$ex", "p o r n", "p.o.r.n", "pörn", Cyrillic "роrn" and "pooorn" all reach it.
// Folding only feeds the denylist; the query itself is never rewritten.
const INVISIBLE_CHARS = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;
const COMBINING_MARKS = /[\u0300-\u036F]/g;
const HOMOGLYPHS = {
  '\u0430': 'a', '\u0435': 'e', '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0445': 'x', '\u0443': 'y',
  '\u0456': 'i', '\u0458': 'j', '\u0455': 's', '\u043A': 'k', '\u043C': 'm', '\u0442': 't', '\u043D': 'h',
  '\u03BF': 'o', '\u03B1': 'a', '\u03B5': 'e', '\u03B9': 'i', '\u03BA': 'k', '\u03BD': 'v', '\u03C1': 'p',
};
const HOMOGLYPH_PATTERN = new RegExp(`[${Object.keys(HOMOGLYPHS).join('')}]`, 'g');
// Two maps because "1" stands for both "i" (s1ut) and "l" (1oli).
const LEET_MAPS = [
  { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' },
  { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'l', '|': 'l', '+': 't' },
];
const LEET_CHARS = /[0-9@$!|+]/g;
const HAS_LETTER = /[a-z]/;
// Runs of 2+ single-character tokens ("p o r n") are joined into one word.
const SINGLE_CHAR_RUN = /(?:^| )((?:[a-z0-9] ){1,}[a-z0-9])(?= |$)/g;
// Same, but a leading "a" or "i" stays its own word, so "make a b o m b" reads "make a bomb".
const SINGLE_CHAR_RUN_KEEP_ARTICLE = /(?:^| )(?:[ai] )?((?:[a-z0-9] ){1,}[a-z0-9])(?= |$)/g;
// CP-807: a run that ends in "a" or "i" before a word keeps it as a word too, so
// "m a k e a bomb" reads "make a bomb" (the run before the article is joined).
const SINGLE_CHAR_RUN_BEFORE_ARTICLE = /(?:^| )((?:[a-z0-9] ){1,}[a-z0-9])(?= [ai] )/g;
// Each list is one way to join spaced letters: its patterns run in order.
const RUN_JOINS = [
  [SINGLE_CHAR_RUN],
  [SINGLE_CHAR_RUN_KEEP_ARTICLE],
  [SINGLE_CHAR_RUN_BEFORE_ARTICLE, SINGLE_CHAR_RUN_KEEP_ARTICLE],
];
const STRETCHED_LETTERS = /([a-z])\1{2,}/g;

function foldUnicode(query) {
  return String(query || '')
    .normalize('NFKD')
    .replace(INVISIBLE_CHARS, '')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(HOMOGLYPH_PATTERN, (ch) => HOMOGLYPHS[ch]);
}

// Leetspeak is undone only inside tokens that already hold a letter, so "$400" and "1080"
// stay numbers while "p0rn" and "$ex" become words.
function unleet(text, map) {
  return text
    .split(/\s+/)
    .map((token) => (HAS_LETTER.test(token) ? token.replace(LEET_CHARS, (ch) => map[ch] ?? ch) : token))
    .join(' ');
}

function joinRuns(normalized, pattern) {
  return normalized.replace(pattern, (match, run) => match.slice(0, match.length - run.length) + run.replace(/ /g, ''));
}

// normalize between passes pads the text again, so the next pattern sees whole words.
function joinSingleChars(normalized, patterns = [SINGLE_CHAR_RUN]) {
  return patterns.reduce((text, pattern) => normalize(joinRuns(text, pattern)), normalized);
}

/** Every form of a query the denylist checks: plain, plus leetspeak, spacing and stretch folds. */
export function denylistForms(query) {
  const folded = foldUnicode(query);
  const forms = new Set([normalize(query), normalize(folded)]);
  for (const map of LEET_MAPS) {
    for (const runPattern of RUN_JOINS) {
      // Symbols read as letters ("$ex"), and symbols read as punctuation ("p0rn!", "s3x+toys").
      const symbolsAsLetters = normalize(unleet(joinSingleChars(normalize(unleet(folded, map)), runPattern), map));
      const symbolsAsSpaces = normalize(unleet(joinSingleChars(normalize(folded), runPattern), map));
      for (const form of [symbolsAsLetters, symbolsAsSpaces]) {
        forms.add(form);
        forms.add(form.replace(STRETCHED_LETTERS, '$1'));
      }
    }
  }
  return [...forms];
}

/**
 * Screen a query. Returns { blocked, reason } where reason is 'adult' | 'illegal' | 'probe' | null.
 * Deterministic, fail-closed, no network. Run this BEFORE the LLM classifier and research.
 *
 * @param {string} query
 * @param {{ allowUrl?: boolean }} [options]
 */
export function screenQuery(query, options = {}) {
  const raw = typeof query === 'string' ? query.trim() : '';
  if (raw.length === 0) return { blocked: false, reason: null };

  if (isProbeQuery(raw, options)) {
    return { blocked: true, reason: 'probe' };
  }

  const forms = denylistForms(raw);
  if (matchesAny(forms, ADULT_PATTERNS)) return { blocked: true, reason: 'adult' };
  if (matchesAny(forms, ILLEGAL_PATTERNS)) return { blocked: true, reason: 'illegal' };

  return { blocked: false, reason: null };
}

function matchesAny(forms, patterns) {
  return forms.some((form) => patterns.some((re) => re.test(form)));
}

/** User-facing rejection message for a blocked query (no detail that aids circumvention). */
export function rejectionMessage(reason) {
  if (reason === 'adult') return "We don't research adult or sexually explicit content. Try a different product or topic.";
  if (reason === 'illegal') return "We can't research illegal products or activities. Try a different product or topic.";
  if (reason === 'probe') return "We can't research queries formatted as code, scripts, or scanner payloads. Try a shopping question instead.";
  return "We can't research that query. Try a different product or topic.";
}

// LLM classifier reject_reason → our coarse safety reason (for enforcing the second layer).
export function classifierRejectToReason(rejectReason) {
  if (rejectReason === 'adult') return 'adult';
  if (rejectReason === 'illegal' || rejectReason === 'self-harm' || rejectReason === 'harassment') return 'illegal';
  if (rejectReason === 'probe') return 'probe';
  return 'policy';
}
