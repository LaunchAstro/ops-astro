// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-22 (REVIEW-BATCH-2 #312, batch 3a). An older version's
// reservation must not decide the run's state. A lineage whose v1 was
// approved and ran to an actual cost, and whose v2 now waits at a pending
// gate, is at the human gate: v2 has not run. `stateOf` in
// `packages/ui/src/state/agent-run.ts` reads the newest reservation whatever
// version it belongs to, so v1's `actual` makes the story "Done", and
// `gateBox` then draws v2's pending gate stale ("The run moved on without
// it.") with nothing to decide. Fixtures in `mp-6-1-agent-fixtures.tsx`; the
// shape is the "MP-6-1 one story" case's.

import { describe, expect, it } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import { DIGEST, lineage, version } from './mp-6-1-agent-fixtures.tsx';

type Reservation = RunLineage['reservations'][number];

/** v1, approved, ran and settled. */
const v1 = version({
  versionId: 'v-1',
  version: 1,
  runId: 'run-1',
  supersededAt: '2026-09-30T00:00:00.000Z',
  gate: {
    id: 'g-1',
    state: 'approved',
    round: 0,
    expiresAt: '2026-10-01T00:00:00.000Z',
    expired: false,
    payloadDigest: DIGEST,
  },
});

/** v2, the head, staged and waiting on a person. */
const v2 = version({
  versionId: 'v-2',
  version: 2,
  runId: null,
  gate: {
    id: 'g-2',
    state: 'pending',
    round: 0,
    expiresAt: '2026-10-09T00:00:00.000Z',
    expired: false,
    payloadDigest: DIGEST,
  },
});

/** v1's reservation, settled at its actual cost. */
const v1Actual: Reservation = {
  runId: 'run-1',
  state: 'actual',
  heldMinor: 0,
  actualMinor: 1_200,
  classifiedCause: null,
  lease: { state: 'released' },
  attempt: { state: 'succeeded', outcome: 'completed' },
};

describe('REVIEW-3A-22 older version reservation', () => {
  it('REVIEW-3A-22: the head at a pending gate is at-gate with the gate armed, whatever an older version’s reservation says', () => {
    const story = runStories([lineage({ versions: [v2, v1], reservations: [v1Actual] })]).at(-1)!;
    expect(story.state).toBe('at-gate');
    expect(story.word).toBe('At human gate');
    expect(story.gate.kind).toBe('armed');
    expect(story.gate.kind === 'none' ? null : story.gate.invalidatedBy).toBeNull();
    // One story: the summary, the gate box and the job list agree.
    expect(story.blockedBy).toBe('Human approval');
    expect(story.jobs.some((job) => job.state === 'pending')).toBe(true);
  });
});
