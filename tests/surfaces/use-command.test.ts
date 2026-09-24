// SPDX-License-Identifier: AGPL-3.0-only
//
// The settlement classifier behind `useCommand` (thermo review H8).
//
// Every web write used to classify its own answer by hand, so this pins the
// one table they now share: which codes close a control, which one means a
// conflict, and that the text is the server's own, unchanged by the move.

import { describe, expect, it } from 'vitest';
import { settle } from '../../apps/web/src/records/use-command.ts';
import { describeFailure } from '../../apps/web/src/records/submit.ts';
import type {
  CommandOutcome,
  CallResult,
  WireRefusal,
} from '../../apps/web/src/operations/client.ts';

const refusal = (code: string): WireRefusal => ({
  refused: true,
  code,
  names: ['task'],
  fixes: ['Read the task again.'],
});

describe('settle', () => {
  it('classifies each answer once, keeping the words describeFailure gives', () => {
    const cases: readonly [CallResult<CommandOutcome>, string][] = [
      [{ ok: true, value: { recordId: 'r-1', revision: 4 } as CommandOutcome }, 'ok'],
      [refusal('VERSION_STALE'), 'stale'],
      [refusal('SCOPE_NOT_GRANTED'), 'closed'],
      [refusal('TRANSITION_PROTECTED'), 'failed'],
      [refusal('GATE_EXPIRED'), 'failed'],
      [{ unavailable: true, because: 'The API answered 503.' }, 'unknown'],
    ];
    for (const [result, kind] of cases) {
      const settlement = settle(result);
      expect(settlement.kind).toBe(kind);
      expect(settlement.kind === 'ok' ? null : settlement.because).toBe(describeFailure(result));
    }
  });

  it('carries the refusal itself for a conflict, so the screen can quote it', () => {
    const stale = refusal('VERSION_STALE');
    const settlement = settle(stale);
    expect(settlement.kind === 'stale' ? settlement.refusal : null).toBe(stale);
  });
});
