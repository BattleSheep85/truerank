/**
 * "Talk about it" chat — POST /api/chat
 *
 * Two modes, one endpoint:
 *  - refine (no slug): help the visitor figure out WHAT to research before
 *    running the pipeline. May return suggested_query when the conversation
 *    converges on a researchable question.
 *  - report ask (slug): answer follow-up questions grounded in a completed report.
 *  - report refine (slug + mode=refine): chat to reshape constraints and rerun
 *    research via suggested_query + refinements map.
 *
 * Cheap by design: google/gemini-3.8-flash, ≤1500 output tokens (reasoning tokens
 * count against max_tokens, so a low cap empties the reply), 20 msgs/hr/IP,
 * and every call's real cost feeds the same monthly budget governor as
 * research runs (503 when the month is spent).
 */

import { checkRateLimit, ipRateKey } from '../lib/rate-limit.js';
import { checkBurstGate } from '../lib/burst-gate.js';
import { getResearchBySlug, getProductsByResearchId } from '../lib/db.js';
import { parseJsonSafe, displayQuery } from '../lib/utils.js';
import { budgetExhausted, incrementMonthlyCost } from '../pipeline/orchestrator.js';
import { llmRouteFromEnv, fetchWithFallback, costFromUsage, LITELLM_MODEL_MAP } from '../lib/llm-route.js';

const CHAT_MODEL = 'google/gemini-3.8-flash';
const CHAT_TIMEOUT_MS = 25_000;
const CHAT_MAX_TOKENS = 1_500;
const MAX_MESSAGES = 16;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TOTAL_CHARS = 12_000;

const REFINE_SYSTEM_PROMPT = `You are Frank, the research concierge behind this site. Frank reads real reviews (Reddit, forums, independent testers), down-weights affiliate bait and marketing-only sources, and produces one honest ranked comparison for any product, service, place, or thing worth comparing, not just tech. (Accuracy note: Frank scores sources by credibility and conflict of interest; it does not claim per-review fake detection. Never tell users we "detect fake reviews.")

Your job: help the visitor figure out what to research. Ask at most ONE short question per turn (budget, use case, constraints). As soon as you have enough to form a specific researchable query, propose it.

Rules:
- Be warm, brief (under 80 words), plain text — no markdown, no lists unless asked.
- Never invent product recommendations yourself; that's the research pipeline's job. You only help shape the question.
- When you have a specific query ready, set suggested_query to it (e.g. "best cordless drill under $150 for home projects"). Otherwise set it to null.
- Decline medical/legal/financial-advice topics politely and steer toward a researchable product angle.

Respond ONLY with JSON: {"reply": string, "suggested_query": string | null}`;

function reportSystemPrompt(entry, products, resultData) {
    const productLines = products.slice(0, 10).map((p) => {
        const bits = [
            `#${p.rank ?? '?'} ${p.name}${p.brand ? ` (${p.brand})` : ''}`,
            p.price != null ? `$${p.price}` : null,
            p.rating != null ? `rating ${p.rating}/5` : null,
            p.best_for ? `best for: ${p.best_for}` : null,
            p.verdict ? `verdict: ${p.verdict}` : null,
            p.pros?.length ? `pros: ${p.pros.slice(0, 4).join('; ')}` : null,
            p.cons?.length ? `cons: ${p.cons.slice(0, 4).join('; ')}` : null,
        ].filter(Boolean);
        return `- ${bits.join(' | ')}`;
    }).join('\n');

    const guide = resultData?.buyersGuide;
    const guideText = guide
        ? [
            guide.howToChoose ? `How to choose: ${guide.howToChoose}` : null,
            guide.pitfalls?.length ? `Pitfalls: ${guide.pitfalls.join('; ')}` : null,
            guide.marketingToIgnore?.length ? `Marketing to ignore: ${guide.marketingToIgnore.join('; ')}` : null,
        ].filter(Boolean).join('\n')
        : '';

    return `You are Frank, the research assistant behind this site, answering follow-up questions about ONE completed research report. Ground every answer in the report below. If the user asks something the report doesn't cover, say so honestly and suggest what a fresh research run could answer, set suggested_query to that new query in that case, otherwise null.

REPORT — "${displayQuery(entry.query)}"
Summary: ${entry.summary || '(none)'}
Ranked items:
${productLines || '(none)'}
${guideText ? `Buyer's guide:\n${guideText}` : ''}

Rules:
- Plain text, under 150 words, no markdown.
- Never fabricate specs, prices, or claims not in the report.
- It's fine to compare items in the report or explain WHY one ranked above another using the pros/cons.
- This report may earn affiliate commission, but rankings are independent — say so if asked.

Respond ONLY with JSON: {"reply": string, "suggested_query": string | null}`;
}

function reportRefineSystemPrompt(entry, products, resultData, clarifications) {
    const productLines = products.slice(0, 8).map((p) => {
        const bits = [
            `#${p.rank ?? '?'} ${p.name}`,
            p.price != null ? `$${p.price}` : null,
            p.best_for ? `best for: ${p.best_for}` : null,
        ].filter(Boolean);
        return `- ${bits.join(' | ')}`;
    }).join('\n');

    const clarifyText = Object.keys(clarifications).length > 0
        ? Object.entries(clarifications).map(([k, v]) => `${k}: ${v}`).join('; ')
        : '(none)';

    return `You are Frank, the research refinement assistant behind this site. The user already has a completed report and wants to REFINE or RERUN the research with different constraints: narrower budget, different use case, exclude certain picks, focus on a sub-category, etc.

ORIGINAL QUERY: "${displayQuery(entry.query)}"
PREVIOUS CLARIFICATIONS: ${clarifyText}
SUMMARY: ${entry.summary || '(none)'}
RANKED ITEMS:
${productLines || '(none)'}

Your job: help them figure out what to change. Ask at most ONE short question per turn until you have enough to propose a refined research run.

Rules:
- Plain text, under 100 words, no markdown.
- Never invent new product rankings — only help reshape the question.
- When ready, set suggested_query to a specific researchable query AND refinements to a map of snake_case constraint keys → short values (budget, use_case, location, etc.). Merge changed constraints with what they asked for.
- If still clarifying, set suggested_query and refinements to null.

Respond ONLY with JSON: {"reply": string, "suggested_query": string | null, "refinements": object | null}`;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
}

// Validate and sanitize the client transcript into OpenRouter messages.
function sanitizeMessages(raw) {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) return null;
    const out = [];
    let total = 0;
    for (const m of raw) {
        if (!m || typeof m !== 'object') return null;
        const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
        const content = typeof m.content === 'string' ? m.content.trim().slice(0, MAX_MESSAGE_CHARS) : '';
        if (!role || !content) return null;
        total += content.length;
        if (total > MAX_TOTAL_CHARS) return null;
        out.push({ role, content });
    }
    if (out[out.length - 1].role !== 'user') return null;
    return out;
}

// Calls the shared LLM route (docs/litellm-2026-10.md D2) with one timeout for
// the call and its fallback. `usage.include` is OpenRouter-only; buildRequest
// strips it for LiteLLM. The X-Title header names this caller on OpenRouter.
async function postChat(env, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
        const { response, routeKind } = await fetchWithFallback(
            llmRouteFromEnv(env), body.model, { ...body, usage: { include: true } }, fetch,
            { signal: controller.signal, headers: { 'X-Title': 'Frank Chat' } },
        );
        const model = routeKind === 'litellm' ? LITELLM_MODEL_MAP[body.model] : body.model;
        return { response, model };
    } finally {
        clearTimeout(timer);
    }
}

export async function handleChat(request, env) {
    let body;
    try { body = await request.json(); } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, 400);
    }

    const messages = sanitizeMessages(body?.messages);
    if (!messages) return jsonResponse({ error: 'Invalid messages' }, 400);

    // Atomic burst gate (10/60s per IP) in front of the non-atomic KV hourly
    // window, so a concurrent flood cannot slip past the 20/hr ceiling.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateKey = await ipRateKey('chat', ip, env);
    const burst = await checkBurstGate(env.RL_BURST, rateKey);
    const rate = burst.allowed
        ? await checkRateLimit(env.KV, rateKey, 20, 3600)
        : burst;
    if (!rate.allowed) {
        return jsonResponse({ error: 'Chat limit reached for now — try again in a bit.' }, 429);
    }

    // Same monthly governor as research runs — gate on MAX(KV, D1 completed-spend).
    if (await budgetExhausted(env)) {
        return jsonResponse({ error: 'Monthly budget exhausted — chat is paused until next month.' }, 503);
    }

    // Build the system prompt for the requested mode.
    let systemPrompt = REFINE_SYSTEM_PROMPT;
    const slug = typeof body?.slug === 'string' ? body.slug.trim().slice(0, 200) : '';
    const mode = body?.mode === 'refine' ? 'refine' : 'ask';
    if (slug) {
        if (!/^[a-z0-9-]+$/.test(slug)) return jsonResponse({ error: 'Invalid slug' }, 400);
        const entry = await getResearchBySlug(env.DB, slug);
        if (!entry || entry.status !== 'complete') {
            return jsonResponse({ error: 'Report not found' }, 404);
        }
        const productRows = await getProductsByResearchId(env.DB, entry.id);
        const products = (productRows.results ?? []).map((p) => ({
            ...p,
            pros: parseJsonSafe(p.pros, []),
            cons: parseJsonSafe(p.cons, []),
        }));
        const resultData = parseJsonSafe(entry.result, {});
        const clarifications = parseJsonSafe(entry.clarifications, {});
        systemPrompt = mode === 'refine'
            ? reportRefineSystemPrompt(entry, products, resultData, clarifications)
            : reportSystemPrompt(entry, products, resultData);
    }

    let content = '';
    let cost = 0;
    try {
        const { response, model } = await postChat(env, {
            model: CHAT_MODEL,
            messages: [{ role: 'system', content: systemPrompt }, ...messages],
            response_format: { type: 'json_object' },
            max_tokens: CHAT_MAX_TOKENS,
        });

        if (!response.ok) {
            console.error('[chat] upstream non-ok:', response.status);
            return jsonResponse({ error: 'The assistant is unavailable right now. Try again shortly.' }, 502);
        }
        const data = await response.json();
        content = data.choices?.[0]?.message?.content ?? '';
        cost = costFromUsage(model, data.usage);
    } catch (err) {
        console.error('[chat] request failed:', err instanceof Error ? err.message : String(err));
        return jsonResponse({ error: 'The assistant timed out. Try again.' }, 504);
    }

    await incrementMonthlyCost(env, cost);

    const parsed = parseJsonSafe(content, null);
    const reply = typeof parsed?.reply === 'string' ? parsed.reply.trim().slice(0, 2000) : '';
    const suggested = typeof parsed?.suggested_query === 'string' ? parsed.suggested_query.trim().slice(0, 200) : null;

    // Sanitize optional refinements map (refine mode only).
    let refinements = null;
    if (parsed?.refinements && typeof parsed.refinements === 'object') {
        refinements = {};
        let i = 0;
        for (const [k, v] of Object.entries(parsed.refinements)) {
            if (i >= 5) break;
            if (typeof k !== 'string' || typeof v !== 'string') continue;
            const key = k.trim().slice(0, 40).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
            const val = v.trim().slice(0, 80);
            if (key && val) { refinements[key] = val; i++; }
        }
        if (Object.keys(refinements).length === 0) refinements = null;
    }

    if (!reply) {
        // Model returned non-JSON or empty — degrade to raw text if plausible.
        const fallback = String(content || '').trim().slice(0, 2000);
        if (!fallback) return jsonResponse({ error: 'Empty response — try again.' }, 502);
        return jsonResponse({ reply: fallback, suggestedQuery: null, refinements: null });
    }
    return jsonResponse({
        reply,
        suggestedQuery: suggested && suggested.length >= 3 ? suggested : null,
        refinements,
    });
}
