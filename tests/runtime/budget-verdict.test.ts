// SPDX-License-Identifier: AGPL-3.0-only
//
// H5 (a): the budget verdicts `decide` and `reserve` share, pure. Since thermo
// O2 both callers refuse a missing cap, so there is one policy to pin.

import { describe, expect, it } from 'vitest';
import {
  capVerdict,
  envelopeVerdict,
  type CapCommitted,
} from '../../packages/core-runtime/src/budget.ts';

const CAP_ID = '00000000-0000-4000-8000-000000000001';
const cap = (over: Partial<CapCommitted> = {}): CapCommitted => ({
  limitMinor: '1000',
  committed: '400',
  currency: 'AUD',
  ...over,
});

describe('capVerdict', () => {
  it('refuses a missing cap, whether or not the caller binds a currency', () => {
    expect(capVerdict({ cap: undefined, capId: CAP_ID, wanted: 1n, currency: null })).toStrictEqual(
      capVerdict({ cap: undefined, capId: CAP_ID, wanted: 1n, currency: 'AUD' }),
    );
    const verdict = capVerdict({ cap: undefined, capId: CAP_ID, wanted: 1n, currency: 'AUD' });
    expect(verdict).toStrictEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: 'BUDGET_UNAVAILABLE',
        reason: `no budget cap ${CAP_ID} in this business`,
      }),
    });
  });

  it('fills the cap exactly and refuses one unit more, past 2^53', () => {
    const limit = (2n ** 53n + 1n).toString();
    const full = cap({ limitMinor: limit, committed: '0' });
    const args = { cap: full, capId: CAP_ID, currency: 'AUD' } as const;
    expect(capVerdict({ ...args, wanted: 2n ** 53n + 1n })).toBeNull();
    expect(capVerdict({ ...args, wanted: 2n ** 53n + 2n })?.ok).toBe(false);
    expect(capVerdict({ ...args, wanted: 2n ** 53n + 2n })).toStrictEqual({
      ok: false,
      refusal: expect.objectContaining({ code: 'BUDGET_EXHAUSTED' }),
    });
  });

  it('binds the currency when the caller names one, and not when it passes null', () => {
    const usd = cap({ currency: 'USD' });
    expect(capVerdict({ cap: usd, capId: CAP_ID, wanted: 1n, currency: 'AUD' })).toStrictEqual({
      ok: false,
      refusal: expect.objectContaining({ code: 'CAP_BINDING_MISMATCH' }),
    });
    expect(capVerdict({ cap: usd, capId: CAP_ID, wanted: 1n, currency: null })).toBeNull();
  });
});

describe('envelopeVerdict', () => {
  const envelope = { maximumMinor: '500', heldMinor: '200', actualMinor: '100' };

  it('fits exactly and refuses one unit more with BUDGET_UNAVAILABLE', () => {
    expect(envelopeVerdict(envelope, 200n)).toBeNull();
    expect(envelopeVerdict(envelope, 201n)).toStrictEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: 'BUDGET_UNAVAILABLE',
        reason: "this task's envelope holds 300 of 500, which leaves no room for 201",
      }),
    });
  });
});
