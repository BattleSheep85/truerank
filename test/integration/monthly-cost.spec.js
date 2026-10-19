// CP-375: the monthly spend counter must not lose updates when runs finish at
// the same time. incrementMonthlyCost adds to a D1 row in one atomic upsert;
// the KV cost:YYYY-MM key is only a cache of that total.
import { env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { applySchema } from './_schema.js';
import {
  incrementMonthlyCost, monthlyLedgerUsd, monthlySpendUsd, budgetExhausted,
} from '../../worker/lib/budget.js';
import { monthKey } from '../../worker/lib/utils.js';

const kvKey = () => `cost:${monthKey()}`;

beforeAll(async () => {
  await applySchema(env.DB);
});

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM monthly_spend').run();
  await env.KV.delete(kvKey());
});

describe('incrementMonthlyCost', () => {
  it('keeps every cost when 20 runs finish together', async () => {
    await Promise.all(Array.from({ length: 20 }, () => incrementMonthlyCost(env, 0.5)));
    expect(await monthlyLedgerUsd(env)).toBeCloseTo(10, 6);
    expect(await monthlySpendUsd(env)).toBeGreaterThanOrEqual(10 - 1e-6);
  });

  it('closes the budget gate at the cap after concurrent spend', async () => {
    const capped = { ...env, MONTHLY_BUDGET_USD: '10' };
    await Promise.all(Array.from({ length: 20 }, () => incrementMonthlyCost(capped, 0.5)));
    expect(await budgetExhausted(capped)).toBe(true);
  });

  it('writes the D1 total to the KV cache', async () => {
    await incrementMonthlyCost(env, 1.25);
    await incrementMonthlyCost(env, 0.75);
    expect(Number(await env.KV.get(kvKey()))).toBeCloseTo(2, 6);
  });

  it('ignores zero, negative and NaN costs', async () => {
    await incrementMonthlyCost(env, 0);
    await incrementMonthlyCost(env, -3);
    await incrementMonthlyCost(env, Number.NaN);
    expect(await monthlyLedgerUsd(env)).toBe(0);
    expect(await env.KV.get(kvKey())).toBeNull();
  });

  it('falls back to the KV counter when D1 is down, so no cost is dropped', async () => {
    const downDb = { prepare() { throw new Error('D1 unavailable'); } };
    const noDb = { ...env, DB: downDb };
    await incrementMonthlyCost(noDb, 2);
    await incrementMonthlyCost(noDb, 3);
    expect(Number(await env.KV.get(kvKey()))).toBeCloseTo(5, 6);
    expect(await monthlyLedgerUsd(noDb)).toBe(0);
  });
});

describe('incrementMonthlyCost across the migration and D1 outages', () => {
  it('seeds a new month row with the spend KV already holds', async () => {
    await env.KV.put(kvKey(), '45');
    await incrementMonthlyCost(env, 0.1);
    expect(await monthlyLedgerUsd(env)).toBeCloseTo(45.1, 6);
    expect(Number(await env.KV.get(kvKey()))).toBeCloseTo(45.1, 6);
  });

  it('keeps costs counted during a D1 outage after D1 comes back', async () => {
    await incrementMonthlyCost(env, 1);
    const noDb = { ...env, DB: { prepare() { throw new Error('D1 unavailable'); } } };
    await incrementMonthlyCost(noDb, 2);
    await incrementMonthlyCost(noDb, 3);
    await incrementMonthlyCost(env, 0.5);
    expect(Number(await env.KV.get(kvKey()))).toBeCloseTo(6.5, 6);
    const capped = { ...env, MONTHLY_BUDGET_USD: '6.5' };
    expect(await budgetExhausted(capped)).toBe(true);
  });
});

describe('monthlySpendUsd', () => {
  it('uses the ledger when it holds more than the completed research rows', async () => {
    await incrementMonthlyCost(env, 4);
    expect(await monthlySpendUsd(env)).toBeGreaterThanOrEqual(4 - 1e-6);
  });
});
