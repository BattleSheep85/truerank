// CP-428: GET /metrics returns snake_case keys. docs/metrics-api.md lists them;
// this spec pins the names so a rename breaks a test, not a dashboard.
import { env } from 'cloudflare:test';
import { beforeAll, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import { insertProductV2 } from './_helpers.js';
import { handleMetrics } from '../../worker/pages/metrics.js';

const TOKEN = 'metrics-test-token';
const metricsEnv = () => ({ ...env, METRICS_TOKEN: TOKEN });
const request = (auth) => new Request('https://frank.test/metrics', {
  headers: auth ? { Authorization: auth } : {},
});

beforeAll(async () => {
  await applySchema(env.DB);
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `INSERT INTO research (id, slug, query, status, tier, cost_usd, view_count, created_at, completed_at)
     VALUES ('m1', 'best-mice', 'best mice', 'complete', 'deep', 0.05, 12, ?1, ?2)`,
  ).bind(now - 120, now - 60).run();
  await insertProductV2(env.DB, { id: 'mp1', researchId: 'm1', name: 'Mouse One' });
});

describe('GET /metrics', () => {
  it('answers 503 when METRICS_TOKEN is unset', async () => {
    const res = await handleMetrics(request(`Bearer ${TOKEN}`), { ...env, METRICS_TOKEN: '' });
    expect(res.status).toBe(503);
  });

  it('answers 401 for a wrong token', async () => {
    const res = await handleMetrics(request('Bearer nope'), metricsEnv());
    expect(res.status).toBe(401);
  });

  it('returns the documented snake_case keys', async () => {
    const res = await handleMetrics(request(`Bearer ${TOKEN}`), metricsEnv());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual([
      'affiliate_clicks', 'budget', 'flywheel', 'gsc', 'guide_clicks', 'runs',
      'server_now', 'subscribers', 'top_pages', 'unserved_demand',
    ]);
    expect(Object.keys(body.budget).sort()).toEqual(
      ['budget_usd', 'month', 'pct_used', 'remaining_usd', 'spent_usd'],
    );
    expect(Object.keys(body.runs).sort()).toEqual(
      ['avg_duration_seconds', 'by_status', 'by_tier', 'cost_usd', 'window_days'],
    );
    expect(Object.keys(body.runs.cost_usd).sort()).toEqual(['avg', 'counted_runs', 'total']);
    expect(Object.keys(body.affiliate_clicks).sort()).toEqual(['last_30d', 'top_products', 'total']);
    expect(Object.keys(body.unserved_demand).sort()).toEqual(['find_handoffs', 'weak_results']);
    expect(Object.keys(body.gsc).sort()).toEqual(['available', 'opportunities', 'top']);
  });

  it('fills top_pages and weak_results from real rows', async () => {
    const body = await (await handleMetrics(request(`Bearer ${TOKEN}`), metricsEnv())).json();
    expect(body.top_pages[0]).toEqual({
      slug: 'best-mice', query: 'best mice', views: 12, clicks: 0, ctr_pct: 0, product_count: 1,
    });
    expect(body.runs.by_status).toEqual({ complete: 1 });
    expect(body.runs.cost_usd.counted_runs).toBe(1);
    expect(body.unserved_demand.weak_results[0]).toEqual(
      { query: 'best mice', status: 'complete', product_count: 1 },
    );
  });

  it('adds gsc_* diagnostic keys only when asked', async () => {
    const body = await (await handleMetrics(request(`Bearer ${TOKEN}`), metricsEnv())).json();
    expect(Object.keys(body).filter((k) => k.startsWith('gsc_'))).toEqual([]);
  });
});
