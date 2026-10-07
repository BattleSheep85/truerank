# LiteLLM switch and evidence gap (2026-10-07)

After this ships, every Frank LLM call can go through the owner's LiteLLM proxy with the
Frank virtual key, and page reads keep working when the Jina key is out of credit.

## Facts found on 2026-10-07

- Search providers work: Serper, Brave, and Tavily answered with results.
- The Jina key answers HTTP 402 (no credit). Jina without a key answers 200.
  Every keyed page read fails, so claim pages and evidence pages come back empty.
- OpenRouter has about 7 USD left of its 100 USD limit.
- Production research runs: 28 of 35 failed in the last 30 days, mostly
  "No reliable products found for this query."
- LiteLLM (Blackbox stack 148) serves `anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-5`,
  `google/gemini-3.8-flash` and others. Upstreams are Anthropic and Google direct.
- The public LiteLLM host answers 403 to Cloudflare Workers. The BunkerWeb gate on Jodi
  must allow Frank first. That is an owner step.

## Decisions

- D1. Virtual key `frank-prod` (BWS `FRANK_LITELLM_API_KEY`), models haiku-4-5, sonnet-5,
  gemini-3.8-flash, budget 60 USD per 30 days (matches `MONTHLY_BUDGET_USD`).
- D2. `LLM_PROVIDER` selects the route: `openrouter` (default) or `litellm`. With `litellm`,
  a network error, 401, 403, 404, 429, or 5xx falls back to OpenRouter once when an
  OpenRouter key exists. ASSUMED: keeps the site up while the gate is closed.
- D3. Model map for LiteLLM:
  - `google/gemini-3.8-flash` to `google/gemini-3.8-flash`
  - An unmapped model goes to OpenRouter with a log line.
  - Changed 2026-10-08: the `minimax/minimax-m3` and `anthropic/claude-haiku-4.5` entries were removed.
    The Anthropic account behind LiteLLM has no credit, so those calls only failed and then fell back.
    `LITELLM_MODEL_MAP_JSON` can still map a model to an Anthropic target.
- D4. LiteLLM does not return a USD cost in the stream. Cost comes from a per-model price
  table (USD per token, from LiteLLM `/model/info`) times the usage token counts.
- D5. OpenRouter-only request fields (`provider`, `models`, `reasoning` object) are not sent
  to LiteLLM. Reasoning effort is sent as `reasoning_effort`.
- D6. Jina: a 401, 402, or 403 with a key retries once without the key. The isolate then
  skips the key for 10 minutes.
- D7. The home gateway admits a request only with the `X-Edge-Gate` header. The value is
  the BWS key `LITELLM_EDGE_GATE`. Set it as the wrangler secret `LITELLM_GATE_TOKEN`.
  The route trims the value. A missing or blank value sends no header. Only LiteLLM
  requests carry the header. OpenRouter requests and the OpenRouter fallback never get it.
  Error messages and logs do not include it.
