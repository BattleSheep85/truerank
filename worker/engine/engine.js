// Research agent engine. Plain ES module, ported from src/lib/engine.ts.
// Types erased. Event writes go through an async onEvent(type, message, detail)
// callback instead of a D1 research_events table (Frank has no events table.
// the wiring agent connects onEvent to the KV progress updater).
import { buildAgentTools, executeTool } from './tools.js';
import { buildAgentPrompt, buildSynthesisPrompt } from './prompts.js';
import { callLLM, callLLMStreaming, pruneMessages } from './llm.js';
import { validateResearchResult } from './validate.js';
import { synthesizeHonest } from './extract/index.js';
import { parseFencedJson } from '../lib/llm-json.js';
import { runPool } from '../lib/pool.js';
import { runRecallGather } from './recall-gather.js';
import { runOpeningBook, OPENING_BOOK_TEMPLATES } from './opening-book.js';

// ─── Event emission ────────────────────────────────────────────────────────
//
// onEvent(type, message, detail?) is provided in runEngine's args. It replaces
// the former writeEvent(db, researchId, seq, ...) D1 insert. emitEvent wraps it
// so a failing/absent callback never aborts research, and bumps the legacy
// eventSeq counter for continuity with the old ordering semantics.
async function emitEvent(onEvent, state, eventType, message, detail) {
  state.eventSeq++;
  if (!onEvent) return;
  try {
    await onEvent(eventType, message, detail ?? null);
  } catch (err) {
    console.log(`[event] write failed seq=${state.eventSeq}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Main engine ─────────────────────────────────────────────────────────────
//
// EngineResult shape (erased interface):
//   { result, sources, notes, totalCostUsd, synthModel }
//   - notes: exposed so a bench harness can persist agent notes alongside the
//     source corpus (prod only needs {result, sources}; notes are consumed by
//     synth and discarded — but for replay we need them).
//   - totalCostUsd: sum of OpenRouter usage.cost across every LLM call made for
//     this research. NaN-safe: 0 when no usage was returned.
//   - synthModel: the synth model the engine actually ran.

// CF Workers paid plan: 1000 subrequests per invocation.
// Post-engine persistEngineResult() requires headroom for:
//   - ASIN resolution: up to 8 products * ~5 provider queries max = 40
//   - Image resolution: up to 8 products * 1 query max = 8
//   - IndexNow ping & cache purge = 5
//   - Subscriber notifications: capped per-invocation batch = 25
//   - Safety margin / retries: 22
//   --------------------------------------------------------------
//   Total POST_ENGINE_RESERVE = 100 subrequests.
// Synthesis reserve (LLM call + retries) = 5 subrequests.
// Engine budget = PLATFORM_SUBREQUEST_LIMIT - POST_ENGINE_RESERVE = 900.
// Maximum subrequests usable in agent loop = SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS = 895.
// Total worst-case invocation subrequests: 895 (loop) + 5 (synth) + 100 (post-engine) = 1000 <= 1000.
export const PLATFORM_SUBREQUEST_LIMIT = 1000;
export const POST_ENGINE_RESERVE = 100;
export const SUBREQUEST_RESERVE_FOR_SYNTHESIS = 5;
export const SUBREQUEST_BUDGET = PLATFORM_SUBREQUEST_LIMIT - POST_ENGINE_RESERVE;
// Searches reserved for the post-planner recall gather phase so recall-driven
// searches can still run after the planner loop ends.
export const RECALL_RESERVE_SEARCHES = 8;

export async function runEngine(
  query,
  config,
  openrouterKey,
  env,
  onEvent,
  facets,
  topicalCategory,
  clarifications,
) {
  const loopSearchCap = Math.max(1, config.maxSearches - RECALL_RESERVE_SEARCHES);
  const agentTools = buildAgentTools(facets);
  // Default recency_sensitive to true when facets are missing (legacy rows in
  // the queue). Matches the classifier's default — tech-heavy traffic wants
  // the aggressive filter by default.
  const recencySensitive = facets?.recency_sensitive ?? true;
  const toolCtx = { env, recencySensitive };
  const startTime = Date.now();
  let subrequestsUsed = 0;
  const state = {
    searchCount: 0,
    fetchCount: 0,
    toolCallCount: 0,
    sources: [],
    notes: [],
    eventSeq: 0,
    totalCostUsd: 0,
  };

  await emitEvent(onEvent, state, 'status', `Starting ${config.maxSearches}-search research...`);

  // ── Phase 1: Agent loop (tool use) ──────────────────────────────────────

  const messages = [
    { role: 'system', content: buildAgentPrompt(query, config, facets) },
    { role: 'user', content: `Research this thoroughly: "${query}"` },
  ];

  // ── Opening book: deterministic template searches before planner loop ───
  const openingCap = Math.min(OPENING_BOOK_TEMPLATES.length, loopSearchCap);
  if (
    openingCap >= 1 &&
    subrequestsUsed + openingCap * 6 < SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS
  ) {
    try {
      const ob = await runOpeningBook({
        query,
        topicalCategory,
        facets,
        env,
        recencySensitive,
        maxSearches: openingCap,
      });
      if (ob) {
        state.searchCount += ob.searched;
        subrequestsUsed += ob.searched * 6;
        if (ob.sources && ob.sources.length > 0) {
          const knownUrls = new Set(state.sources.map((s) => s?.url).filter(Boolean));
          const newSources = ob.sources.filter((s) => s?.url && !knownUrls.has(s.url));
          state.sources = [...state.sources, ...newSources];
        }
        console.log(`[opening-book] searched ${ob.searched}, sources +${ob.sources.length}`);
        if (ob.searched > 0) {
          await emitEvent(onEvent, state, 'search', `Ran ${ob.searched} opening searches...`);
          const queryList = ob.queries.map((q) => `- ${q}`).join('\n');
          messages.splice(1, 0, {
            role: 'system',
            content: `These searches have ALREADY been run and their results are in the corpus. Do NOT repeat them:\n${queryList}`,
          });
        }
      }
    } catch {
      /* failure must never abort research */
    }
  }

  let turnsWithoutTools = 0;
  const MAX_TURNS = 30; // safety valve

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    // Check agent-loop budget (scrape/plan phase only; synth has its own timer).
    if (Date.now() - startTime > config.agentLoopBudgetMs - 15_000) {
      console.log(`[engine] approaching agent-loop budget, stopping`);
      await emitEvent(onEvent, state, 'status', 'Approaching time limit, finishing up...');
      break;
    }

    // Check tool budget
    if (state.toolCallCount >= config.maxToolCalls) {
      console.log(`[engine] tool budget exhausted (${state.toolCallCount}/${config.maxToolCalls})`);
      await emitEvent(onEvent, state, 'status', 'Tool budget used, synthesizing...');
      break;
    }

    // Check subrequest budget (CF Workers limit)
    if (subrequestsUsed >= SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS) {
      console.log(`[engine] subrequest budget exhausted (${subrequestsUsed}/${SUBREQUEST_BUDGET})`);
      await emitEvent(onEvent, state, 'status', 'Platform limit reached, synthesizing...');
      break;
    }

    // Prune context if needed
    const prunedMessages = pruneMessages(messages, {
      maxChars: config.plannerContextMaxChars,
      keepTail: config.plannerContextKeepTail,
      mode: config.plannerContextMode,
    });
    const contextSize = prunedMessages.reduce((acc, m) => acc + (m.content ?? '').length, 0);
    console.log(`[engine] turn ${turn}: ${prunedMessages.length} messages, ${Math.round(contextSize / 1024)}KB context`);

    let response;
    try {
      subrequestsUsed++; // LLM call = 1 subrequest
      console.log(`[engine] LLM call turn ${turn} (${subrequestsUsed} subs, ${state.toolCallCount} tools)`);
      response = await callLLM(openrouterKey, config.plannerModel, prunedMessages, {
        tools: agentTools,
        reasoning: config.plannerReasoning,   // {effort:'low'} — tool-routing, not deep reasoning
        provider: config.plannerProvider,     // latency-sort + fp8+ accuracy guard
        hardMsOverride: config.plannerHardMs, // cap a hung routing turn
      });
      if (typeof response.usage?.cost === 'number' && Number.isFinite(response.usage.cost)) {
        state.totalCostUsd += response.usage.cost;
      }
      console.log(`[engine] LLM call turn ${turn} returned`);
    } catch (err) {
      console.log(`[engine] LLM error turn ${turn}: ${err instanceof Error ? err.message : String(err)}`);
      await emitEvent(onEvent, state, 'error', 'AI service temporarily unavailable — retrying');
      // Retry once after a short delay
      if (turn > 0) break;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    const choice = response.choices?.[0];
    if (!choice) {
      console.log(`[engine] no choice in response`);
      break;
    }

    const toolCalls = choice.message.tool_calls;

    if (!toolCalls || toolCalls.length === 0) {
      // LLM stopped calling tools
      turnsWithoutTools++;
      if (turnsWithoutTools >= 2 || choice.message.content) {
        console.log(`[engine] agent finished (turn ${turn}, ${state.toolCallCount} tool calls)`);
        break;
      }
      // Nudge: remind the agent it has budget left
      messages.push({
        role: 'assistant',
        content: choice.message.content ?? '',
      });
      messages.push({
        role: 'user',
        content: `You still have ${config.maxToolCalls - state.toolCallCount} tool calls and ${loopSearchCap - state.searchCount} searches remaining. Continue researching or stop if satisfied.`,
      });
      continue;
    }

    turnsWithoutTools = 0;

    // Add assistant message with tool_calls to history
    messages.push({
      role: 'assistant',
      content: choice.message.content ?? null,
      tool_calls: toolCalls,
    });

    // Execute the turn's tool calls CONCURRENTLY (the dominant latency lever — a
    // 4-tool turn drops from sum-of-latencies to max-of-latencies). A synchronous
    // PRE-PASS admits each call against ALL budgets first — tool budget, subrequest
    // ceiling (reserving each tool's worst-case subs), and the per-kind search/fetch
    // caps — because searchCount/fetchCount increment INSIDE executeTool, so a
    // concurrent batch would otherwise race past maxSearches/maxFetches.
    const outcome = new Map();   // tc.id → tool-message content (skip-stub or result)
    const admitted = [];
    let projSearch = 0, projFetch = 0, projSubs = 0;
    const worstSubs = (nm) => (nm === 'web_search' ? 6 : nm === 'read_page' ? 1 : 0); // rss/video web_search fan to ~6
    for (const tc of toolCalls) {
      const nm = tc.function.name;
      if (state.toolCallCount >= config.maxToolCalls) {
        outcome.set(tc.id, 'Tool budget exhausted.'); continue;
      }
      if (subrequestsUsed + projSubs >= SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS) {
        outcome.set(tc.id, 'Platform subrequest limit reached. Synthesize from what you have.'); continue;
      }
      if (nm === 'web_search' && state.searchCount + projSearch >= loopSearchCap) {
        outcome.set(tc.id, 'Search budget exhausted. Use note() to record findings or stop.'); continue;
      }
      if (nm === 'read_page' && state.fetchCount + projFetch >= config.maxFetches) {
        outcome.set(tc.id, 'Fetch budget exhausted.'); continue;
      }
      state.toolCallCount++;
      if (nm === 'web_search') projSearch++;
      if (nm === 'read_page') projFetch++;
      projSubs += worstSubs(nm);
      admitted.push(tc);
    }

    // Activity-feed events for admitted calls, in order (cheap, sequential).
    for (const tc of admitted) {
      const toolArgs = safeParseArgs(tc.function.arguments);
      const eventMsg = formatToolEvent(tc.function.name, toolArgs);
      await emitEvent(onEvent, state, tc.function.name === 'note' ? 'note' : tc.function.name === 'read_page' ? 'fetch' : 'search', eventMsg, tc.function.arguments);
    }

    // Run admitted calls concurrently (capped pool); fold actual subs + results.
    // onError mirrors the tool-error tuple downstream code already expects.
    const settled = await runPool(
      admitted.map((tc) => () => executeTool(tc, state, config, toolCtx)),
      config.maxConcurrency || 6,
      (err) => [`Tool error: ${err instanceof Error ? err.message : String(err)}`, 0],
    );
    for (let i = 0; i < admitted.length; i++) {
      const [result, subs] = settled[i] || ['Tool error.', 0];
      subrequestsUsed += subs;
      outcome.set(admitted[i].id, result);
    }

    // Neutralize the in-flight source-dedup race: collapse state.sources by url so
    // the corpus synthesis/extraction sees is identical to a sequential run.
    if (state.sources.length) {
      const byUrl = new Map();
      for (const s of state.sources) if (s && s.url && !byUrl.has(s.url)) byUrl.set(s.url, s);
      state.sources = [...byUrl.values()];
    }

    // Append every tool message in ORIGINAL tool_calls order (id pairing intact —
    // the API requires one tool message per tool_call_id).
    for (const tc of toolCalls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: outcome.get(tc.id) ?? 'Tool produced no output.' });
    }
  }

  console.log(`[engine] agent loop done: ${state.toolCallCount} calls, ${state.sources.length} sources, ${state.notes.length} notes`);

  // ── Reserve-spend: recall gather for unevidenced leaders ─────────────────
  const reserveLeft = Math.max(0, config.maxSearches - state.searchCount);
  if (
    reserveLeft >= 1 &&
    Date.now() - startTime <= config.agentLoopBudgetMs - 15_000 &&
    subrequestsUsed + 6 < SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS
  ) {
    const affordable = Math.floor((SUBREQUEST_BUDGET - SUBREQUEST_RESERVE_FOR_SYNTHESIS - subrequestsUsed) / 6);
    const searchCap = Math.min(reserveLeft, affordable, RECALL_RESERVE_SEARCHES);
    if (searchCap >= 1) {
      try {
        const r = await runRecallGather({
          query,
          topicalCategory,
          sources: state.sources,
          notes: state.notes,
          openrouterKey,
          recallModel: config.recallModel,
          env,
          recencySensitive,
          maxNames: 4,
          maxSearches: searchCap,
        });
        if (r) {
          state.searchCount += r.searched;
          subrequestsUsed += r.searched * 6;
          state.sources = [...state.sources, ...r.sources];
          console.log(`[recall-gather] proposed ${r.proposed}, searched ${r.searched}, recovered ${r.recovered}`);
          if (r.searched > 0) {
            await emitEvent(onEvent, state, 'status', `Ran ${r.searched} recall searches for missing leaders...`);
          }
        }
      } catch {
        /* failure must never abort research */
      }
    }
  }

  await emitEvent(onEvent, state, 'status', `Gathered ${state.sources.length} sources with ${state.notes.length} findings. Synthesizing report...`);

  // ── Phase 2: Synthesis ──────────────────────────────────────────────────

  // Experimental (dev-only): deterministic pure-extraction synthesizer. It is a
  // drop-in for the LLM synth step — same inputs, same report JSON shape — but
  // cannot fabricate (every field is a real source span) and ratings are derived
  // by an auditable formula instead of an LLM. Gated by SYNTH_ENGINE=extract so
  // production keeps the proven generative synth path untouched.
  if (env?.SYNTH_ENGINE === 'extract') {
    await emitEvent(onEvent, state, 'synthesize', 'Extracting report from sources (no generative model)...');
    // Single honest synth path (shared with the off-CF gatherer's CF-side synth in
    // handleComplete): deterministic extraction + gated, timeout-bounded con-selector.
    const extracted = await synthesizeHonest({
      query, notes: state.notes, sources: state.sources, facets, topicalCategory,
      openrouterKey, conSelectorModel: config.conSelectorModel, cleanupModel: config.cleanupModel, recallModel: config.recallModel,
    });
    const result = validateResearchResult(extracted, { query, topicalCategory, clarifications });
    await emitEvent(onEvent, state, 'status', `Report complete: ${result.products.length} products ranked.`);
    return {
      result,
      sources: state.sources,
      notes: state.notes,
      totalCostUsd: state.totalCostUsd,
      synthModel: 'extraction-v0',
    };
  }

  await emitEvent(onEvent, state, 'synthesize', 'Writing final report...');

  const synthPrompt = buildSynthesisPrompt(query, state.notes, state.sources, config, facets, topicalCategory, clarifications);

  // Stream the synthesis so we can surface progress beats (product names as they
  // appear in the JSON) instead of a 6s black-box wait. Falls back to non-streaming
  // callLLM if the stream fails so research never dies on a transport blip.
  const announced = new Set();
  const announceProduct = (fullText) => {
    // Cheap scan: pull all completed `"name":"..."` pairs seen so far.
    const re = /"name"\s*:\s*"([^"\\]{3,120}?)"/g;
    let m;
    while ((m = re.exec(fullText)) !== null) {
      const name = m[1].trim();
      if (name && !announced.has(name)) {
        announced.add(name);
        // Fire-and-forget event write; don't await (would stall the stream loop).
        void emitEvent(onEvent, state, 'synthesize', `Writing section: ${name}`);
      }
    }
  };

  // Use SSE streaming for synthesis. Rationale: OpenRouter's non-streaming mode
  // sends SSE-style `:` keep-alive comments every ~2s during upstream generation
  // (chunked transfer-encoding on an application/json body). A per-chunk timer
  // gets reset by those keep-alives, so a silent-upstream hang never aborts.
  // In SSE mode we parse keep-alives as non-data lines and rely on the hard-timer
  // backstop in callLLMStreaming to guarantee forward progress.
  const synthMessages = [
    { role: 'system', content: synthPrompt },
    { role: 'user', content: `Write the research report for: "${query}". Respond ONLY with valid JSON.` },
  ];
  let synthContent = '';
  try {
    const streamRes = await callLLMStreaming(
      openrouterKey,
      config.synthModel,
      synthMessages,
      (_delta, accumulated) => announceProduct(accumulated),
      { reasoning: config.synthReasoning, maxTokens: config.synthMaxTokens, provider: config.synthProvider },
    );
    synthContent = streamRes.content;
    if (typeof streamRes.usage?.cost === 'number' && Number.isFinite(streamRes.usage.cost)) {
      state.totalCostUsd += streamRes.usage.cost;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error('[engine] synth stream failed:', errMsg);
    await emitEvent(onEvent, state, 'status', 'Retrying report...');
    const retry = await callLLM(
      openrouterKey,
      config.synthModel,
      synthMessages,
      { reasoning: config.synthReasoning, maxTokens: config.synthMaxTokens, provider: config.synthProvider },
    );
    if (typeof retry.usage?.cost === 'number' && Number.isFinite(retry.usage.cost)) {
      state.totalCostUsd += retry.usage.cost;
    }
    synthContent = retry.choices?.[0]?.message?.content ?? '';
  }

  if (!synthContent) {
    throw Object.assign(new Error('No synthesis response from LLM'), { totalCostUsd: state.totalCostUsd });
  }

  // Extract JSON — first pass on streamed content.
  let parsed = parseFencedJson(synthContent);

  // If the streamed content didn't parse (stream truncation, early close), retry
  // with the non-streaming path which buffers the full response. This keeps the
  // happy-path UX wins of streaming without sacrificing reliability.
  if (parsed === null) {
    console.warn('[engine] streamed JSON unparseable, retrying non-streaming');
    await emitEvent(onEvent, state, 'status', 'Finalizing report...');
    const retryResponse = await callLLM(
      openrouterKey,
      config.synthModel,
      [
        { role: 'system', content: synthPrompt },
        { role: 'user', content: `Write the research report for: "${query}". Respond ONLY with valid JSON.` },
      ],
      { reasoning: config.synthReasoning, maxTokens: config.synthMaxTokens, provider: config.synthProvider },
    );
    if (typeof retryResponse.usage?.cost === 'number' && Number.isFinite(retryResponse.usage.cost)) {
      state.totalCostUsd += retryResponse.usage.cost;
    }
    const retryContent = retryResponse.choices?.[0]?.message?.content ?? '';
    parsed = parseFencedJson(retryContent);
    if (parsed === null) {
      throw Object.assign(new Error(`Invalid JSON from synthesis: ${retryContent.slice(0, 200)}`), { totalCostUsd: state.totalCostUsd });
    }
  }

  const result = validateResearchResult(parsed, { query, topicalCategory, clarifications });

  await emitEvent(onEvent, state, 'status', `Report complete: ${result.products.length} products ranked.`);

  return {
    result,
    sources: state.sources,
    notes: state.notes,
    totalCostUsd: state.totalCostUsd,
    synthModel: config.synthModel,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParseArgs(argsStr) {
  try {
    return JSON.parse(argsStr);
  } catch {
    return {};
  }
}

function formatToolEvent(name, args) {
  switch (name) {
    case 'web_search':
      return `Searching ${args.provider ?? 'web'}: "${args.query ?? ''}"`;
    case 'read_page':
      return `Reading: ${args.url ?? ''}`;
    case 'note':
      return `Found: ${String(args.content ?? '').slice(0, 80)}${String(args.content ?? '').length > 80 ? '...' : ''}`;
    default:
      return `${name}(${JSON.stringify(args).slice(0, 100)})`;
  }
}
