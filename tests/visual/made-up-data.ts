// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up agent work behind the harness's answers (made-up-api.ts): the
// run and the run's receipt. The task's proposals at an armed gate and its
// ledger are in made-up-agent.ts, and the task rows themselves in
// made-up-rows.ts. Every name is made up. Test side only.

import type { ReceiptResult, TaskExecutionResult } from '../../packages/core-wire/src/index.ts';

// An earlier version of the same lineage was approved and ran: one run whose
// attempt has a receipt, so the Agent perspective draws the mockup's receipt
// box (states.json `receipt`).
export const EXECUTION: TaskExecutionResult = {
  execution: {
    outcome: 'ready',
    runs: [
      {
        runId: 'r-1',
        lineageId: 'l-1',
        versionId: 'v-1',
        state: 'completed',
        taskRevisionAtRequest: 1,
        createdAt: '2026-09-25T05:00:00.000Z',
      },
    ],
    events: [
      {
        eventId: 'e-1',
        runId: 'r-1',
        position: 1,
        kind: 'claimed',
        attemptId: 'a-1',
        at: '2026-09-25T05:00:00.000Z',
      },
      {
        eventId: 'e-2',
        runId: 'r-1',
        position: 2,
        kind: 'effect_observed',
        attemptId: 'a-1',
        at: '2026-09-25T05:02:00.000Z',
      },
    ],
    complete: true,
    next: null,
    graph: { plan: 'unbound', sourceRevision: 1, complete: true, nodes: [] },
    plans: [],
  },
};

export const RECEIPT: ReceiptResult = {
  receipt: {
    attemptId: 'a-1',
    decision: { id: 'd-1' },
    version: { id: 'v-1', number: 1 },
    effect: { kind: 'comment', audience: 'internal' },
    settlement: { state: 'settled', heldMinor: 12_000, spentMinor: 9_500, releasedMinor: 2_500 },
  },
};
