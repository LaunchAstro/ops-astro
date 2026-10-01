// SPDX-License-Identifier: AGPL-3.0-only
//
// The made-up agent work behind the harness's answers (made-up-api.ts): the
// task's proposal at an armed gate, its run and the run's receipt. The task
// rows themselves are in made-up-tasks.ts. Every name is made up. Test side only.

import type {
  ProposalView,
  ReceiptResult,
  TaskExecutionResult,
} from '../../packages/core-wire/src/index.ts';

// One proposal whose newest version waits at an armed gate, so the task page
// draws the mockup's gate box (states.json `gate`). The gate's deadline sits
// after the harness clock, so it reads pending and the controls are offered.
const DIGEST = 'sha256:7c41e8f9a2d6b3915e0c47a8fd23b6c1e94a7f80d5b2c6e31a94f7d2b8c05e4a2';
export const PROPOSAL: ProposalView = {
  lineageId: 'l-1',
  state: 'live',
  versions: [
    {
      versionId: 'v-2',
      version: 2,
      purpose: 'contract_review_pack',
      maximumMinor: 12_000,
      currency: 'AUD',
      payloadDigest: DIGEST,
      payload: { pack: 'Signed scope, two variations and the renewal terms, in one PDF.' },
      supersededAt: null,
      runId: null,
      evidence: null,
      gate: {
        id: 'g-2',
        state: 'pending',
        round: 1,
        expiresAt: '2026-10-03T00:00:00.000Z',
        expired: false,
        payloadDigest: DIGEST,
      },
    },
  ],
  decisions: [],
  reservations: [],
};

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
