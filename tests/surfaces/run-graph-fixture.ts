// SPDX-License-Identifier: AGPL-3.0-only
//
// A task execution graph with one settled run, r-1, whose observed node names
// its currency (AUD): the receipt's money is counted in it (REVIEW-3A-23).

export const SETTLED_AUD_GRAPH = {
  plan: 'unbound',
  sourceRevision: 3,
  complete: true,
  nodes: [
    {
      nodeId: 'r-1',
      condition: 'settled',
      planned: null,
      observed: {
        condition: 'settled',
        runState: 'completed',
        attemptId: 'a-1',
        whoseMove: null,
        outcome: 'succeeded',
        fault: null,
        lease: null,
        effectObserved: true,
        heldMinor: 2000,
        spentMinor: 1500,
        currency: 'AUD',
      },
    },
  ],
};
