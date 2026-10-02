// SPDX-License-Identifier: AGPL-3.0-only
//
// The B4 task page's run as its reads answer it: one settled run, r-1, with its
// execution events and graph, and the receipt the evidence box draws.

import { SETTLED_AUD_GRAPH } from './run-graph-fixture.ts';

export const EXECUTION = {
  execution: {
    outcome: 'ready',
    runs: [
      {
        runId: 'r-1',
        lineageId: 'l-1',
        versionId: 'v-1',
        state: 'completed',
        taskRevisionAtRequest: 3,
        createdAt: '2026-09-29T01:00:00.000Z',
      },
    ],
    events: [
      {
        eventId: 'e-1',
        runId: 'r-1',
        position: 1,
        kind: 'claimed',
        attemptId: 'a-1',
        at: '2026-09-29T01:00:00.000Z',
      },
    ],
    complete: true,
    next: null,
    // The run's node names its currency, which counts the receipt's money (REVIEW-3A-23).
    graph: SETTLED_AUD_GRAPH,
  },
};

export const RECEIPT = {
  ok: true,
  receipt: {
    attemptId: 'a-1',
    decision: { id: 'd-1' },
    version: { id: 'v-1', number: 1 },
    effect: { kind: 'comment', audience: 'internal' },
    settlement: { state: 'settled', heldMinor: 2000, spentMinor: 1500, releasedMinor: 500 },
  },
};
