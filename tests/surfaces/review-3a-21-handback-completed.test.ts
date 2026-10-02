// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-21 (REVIEW-BATCH-2 #312, batch 3a). A completed hand-back must
// read "Done". The server's hand-back releases the run's hold by classifying
// its reservation `abandoned` with the cause `handback_completed`
// (core-runtime `recovery/classifier.ts`), moves the attempt to `abandoned`
// and leaves the lineage live. `stateOf` in `packages/ui/src/state/agent-run.ts`
// reads any abandoned reservation as "Dropped" before it looks at the cause,
// and `cancellable` follows the lineage's `live`, so a finished run is drawn as
// dropped with a Cancel still offered. Fixtures in `mp-6-1-agent-fixtures.tsx`.

import { describe, expect, it } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import { lineage } from './mp-6-1-agent-fixtures.tsx';

type Reservation = RunLineage['reservations'][number];

/** The reservation exactly as the server's hand-back leaves it. */
const handedBack: Reservation = {
  state: 'abandoned',
  heldMinor: 2_500,
  actualMinor: null,
  classifiedCause: 'handback_completed',
  lease: { state: 'released' },
  attempt: { state: 'abandoned' },
};

describe('REVIEW-3A-21 completed hand-back', () => {
  it('REVIEW-3A-21: a reservation released by a completed hand-back reads Done, not Dropped, and cannot be cancelled', () => {
    const story = runStories([lineage({ state: 'live', reservations: [handedBack] })]).at(-1)!;
    expect(story.word).toBe('Done');
    expect(story.state).toBe('done');
    expect(story.tone).toBe('done');
    expect(story.cancellable).toBe(false);
  });

  it('REVIEW-3A-21: a reservation abandoned for any other cause still reads Dropped', () => {
    const story = runStories([
      lineage({ reservations: [{ ...handedBack, classifiedCause: 'lease_expired' }] }),
    ]).at(-1)!;
    expect(story.word).toBe('Dropped');
  });
});
