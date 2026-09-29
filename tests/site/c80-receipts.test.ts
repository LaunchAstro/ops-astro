// SPDX-License-Identifier: AGPL-3.0-only
//
// C80: Receipt L (one live correction, fifteen observations) and Receipt LP
// (the pilot: nine acceptance cases, fifteen preconditions, what stays held).
// A missing field is a missing field, never a passing one.

import { describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_CASES,
  PRECONDITIONS,
  RECEIPT_L_OBSERVATIONS,
  STAYS_HELD,
  receiptL,
  receiptLP,
  type ReceiptLObservations,
} from '../../packages/core-connectors/src/index.ts';

function fullL(): ReceiptLObservations {
  return Object.fromEntries(
    RECEIPT_L_OBSERVATIONS.map((name) => [name, { observed: `observed ${name}` }]),
  ) as unknown as ReceiptLObservations;
}

function fullCases() {
  return Object.fromEntries(
    ACCEPTANCE_CASES.map((entry) => [
      entry.id,
      { result: 'pass' as const, evidence: `case ${entry.id}` },
    ]),
  );
}

function fullPreconditions() {
  return Object.fromEntries(
    PRECONDITIONS.map((entry) => [
      entry.id,
      entry.kind === 'not_a_condition'
        ? { state: 'not_a_condition' as const, evidence: 'release decision precondition 13' }
        : { state: 'held' as const, evidence: `precondition ${entry.id}` },
    ]),
  );
}

describe('C80 receipt LP complete', () => {
  it('names fifteen observations, nine cases and fifteen preconditions', () => {
    expect(RECEIPT_L_OBSERVATIONS).toHaveLength(15);
    expect(ACCEPTANCE_CASES.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(PRECONDITIONS.map((entry) => entry.id)).toEqual([...Array(15).keys()].map((n) => n + 1));
  });

  it('is complete only with every observation, case and precondition filled by evidence', () => {
    const lp = receiptLP({
      receiptL: fullL(),
      cases: fullCases(),
      preconditions: fullPreconditions(),
      revertIntervalMs: 210_000,
    });
    expect(lp).toMatchObject({ complete: true, missing: [] });
    expect(lp.staysHeld).toEqual(STAYS_HELD);
    expect(STAYS_HELD).toHaveLength(8);
  });

  it('is incomplete when one Receipt L observation is empty, and says which', () => {
    const l = fullL();
    delete (l as unknown as Record<string, unknown>)['decoy_unchanged'];
    expect(receiptL(l)).toMatchObject({ complete: false, missing: ['decoy_unchanged'] });
    const lp = receiptLP({ receiptL: l, cases: fullCases(), preconditions: fullPreconditions() });
    expect(lp.complete).toBe(false);
    expect(lp.missing).toContain('receipt_l.decoy_unchanged');
  });

  it('never counts an observation filled with blank text, or a supplied procedure value', () => {
    const l = fullL();
    (l as unknown as Record<string, unknown>)['post_live_address'] = { observed: '  ' };
    (l as unknown as Record<string, unknown>)['after_capture'] = { procedure: 'the plan says so' };
    expect(receiptL(l).missing).toEqual(['post_live_address', 'after_capture']);
  });

  it('keeps an unknown case result unknown, and never a pass', () => {
    const cases = { ...fullCases(), 6: { result: 'unknown' as const, evidence: 'fault injected' } };
    const lp = receiptLP({
      receiptL: fullL(),
      cases,
      preconditions: fullPreconditions(),
      revertIntervalMs: 1,
    });
    expect(lp.complete).toBe(false);
    expect(lp.missing).toEqual(['case.6']);
  });

  it('refuses a precondition marked held with no evidence behind it', () => {
    const preconditions = { ...fullPreconditions(), 4: { state: 'held' as const, evidence: '' } };
    const lp = receiptLP({
      receiptL: fullL(),
      cases: fullCases(),
      preconditions,
      revertIntervalMs: 1,
    });
    expect(lp.missing).toEqual(['precondition.4']);
  });

  it('lets calibration preconditions 14 and 15 be recorded as not run without holding the receipt', () => {
    const preconditions = {
      ...fullPreconditions(),
      14: { state: 'not_run' as const, evidence: 'calibration: layered catch not run' },
    };
    expect(
      receiptLP({ receiptL: fullL(), cases: fullCases(), preconditions, revertIntervalMs: 1 })
        .complete,
    ).toBe(true);
    const gate = { ...fullPreconditions(), 7: { state: 'not_run' as const, evidence: 'no' } };
    expect(
      receiptLP({ receiptL: fullL(), cases: fullCases(), preconditions: gate, revertIntervalMs: 1 })
        .missing,
    ).toEqual(['precondition.7']);
  });

  it('needs the measured revert interval, because case 8 passed', () => {
    const lp = receiptLP({
      receiptL: fullL(),
      cases: fullCases(),
      preconditions: fullPreconditions(),
    });
    expect(lp.missing).toEqual(['revert_interval']);
  });
});
