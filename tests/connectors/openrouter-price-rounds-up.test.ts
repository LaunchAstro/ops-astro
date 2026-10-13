// SPDX-License-Identifier: AGPL-3.0-only
//
// OpenRouter's reported US dollars become whole AUD cents at the fixed rate,
// worked in millionths and never rounded down: a ten-millionth of a dollar is
// a cent, and over many random costs the price is never below the exact one.

import { describe, expect, it } from 'vitest';
import {
  OPENROUTER_AUD_PER_USD,
  openrouterCostMinor,
  type ModelAnswer,
} from '../../packages/core-connectors/src/index.ts';

const answer = (amount: number, currency = 'USD'): ModelAnswer => ({
  text: 'ok',
  model: 'anthropic/claude-haiku-5.5',
  usage: { inputUnits: 1, outputUnits: 1 },
  providerCode: null,
  reportedCost: { currency, amount },
});

describe('the price of a paid answer', () => {
  it('rounds the smallest cost up to a cent', () => {
    expect(openrouterCostMinor(answer(0.000_000_1))).toBe(1);
    expect(openrouterCostMinor(answer(0))).toBe(0);
    expect(openrouterCostMinor(answer(0.01))).toBe(2);
    expect(openrouterCostMinor(answer(1))).toBe(160);
  });

  it('is never below the exact price, and never a cent above it, over random costs', () => {
    const rate = Number(OPENROUTER_AUD_PER_USD);
    for (let at = 0; at < 2_000; at += 1) {
      const micro = Math.floor(Math.random() * 5_000_000);
      const exact = (micro * rate * 100) / 1_000_000;
      const priced = openrouterCostMinor(answer(micro / 1_000_000));
      expect(priced, String(micro)).toBeGreaterThanOrEqual(exact - 1e-9);
      expect(priced, String(micro)).toBeLessThan(exact + 1);
    }
  });

  it('holds where the cost is not in dollars or not a finite amount', () => {
    expect(openrouterCostMinor(answer(0.01, 'AUD'))).toBeNaN();
    expect(openrouterCostMinor(answer(-0.01))).toBeNaN();
    const { reportedCost: _unreported, ...unpriced } = answer(0.01);
    expect(openrouterCostMinor(unpriced)).toBeNaN();
  });
});
