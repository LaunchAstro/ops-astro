// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// REVIEW-BATCH-2 #312 security review S1. An agent hands back with a successor
// while its attempt carries a dispatch marker: in one transaction
// core-runtime `handback.ts` settle() holds the old run's money (the attempt
// liability_unknown, or the reservation quarantined) and writeSuccessor()
// writes v2 with a new run and a pending gate. The old hold is still
// reserved and waits on a person, so it decides the story whatever run it
// was for: Outcome unknown, the attempt to answer for, and its amount held.
// 3a-22's rule (otherwise the head's run decides) is held by its own proof.

import { afterEach, describe, expect, it } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import { DIGEST, lineage, pane, unmountAll, version } from './mp-6-1-agent-fixtures.tsx';

afterEach(unmountAll);

type Reservation = RunLineage['reservations'][number];

const v1 = version({
  versionId: 'v-1',
  version: 1,
  runId: 'run-1',
  supersededAt: '2026-09-30T00:00:00.000Z',
  gate: null,
});

/** The successor the hand-back wrote: a new run, waiting on a person. */
const v2 = version({
  versionId: 'v-2',
  version: 2,
  runId: 'run-2',
  gate: {
    id: 'g-2',
    state: 'pending',
    round: 0,
    expiresAt: '2026-10-09T00:00:00.000Z',
    expired: false,
    payloadDigest: DIGEST,
  },
});

/** v1's hold, kept whole with its effect unknown. */
const unknownHold: Reservation = {
  runId: 'run-1',
  state: 'held',
  heldMinor: 2_500,
  actualMinor: null,
  classifiedCause: null,
  lease: { state: 'released' },
  attempt: { id: 'att-1', state: 'liability_unknown' },
};

/** v1's hold, quarantined by the classifier. */
const quarantined: Reservation = {
  ...unknownHold,
  state: 'quarantined',
  attempt: { id: 'att-1', state: 'dispatched' },
};

const ignore = (): void => {
  // The answer is not under test here, only that it is offered.
};

const storyOf = (reservations: readonly Reservation[]) =>
  runStories([lineage({ versions: [v2, v1], reservations })]).at(-1)!;

describe('REVIEW-3A-S1 an unknown hold on an older run after a hand-back with a successor', () => {
  it('REVIEW-3A-S1: v1 held with its effect unknown keeps the story at Outcome unknown, with the attempt and its hold', () => {
    const story = storyOf([unknownHold]);
    expect(story.state).toBe('unknown-outcome');
    expect(story.unknownAttempt).toStrictEqual({ id: 'att-1', heldMinor: 2_500 });
    expect(story.heldMinor).toBe(2_500);
  });

  it('REVIEW-3A-S1: v1 quarantined keeps the story at Outcome unknown with its hold', () => {
    const story = storyOf([quarantined]);
    expect(story.state).toBe('unknown-outcome');
    expect(story.heldMinor).toBe(2_500);
  });

  it('REVIEW-3A-S1: once v2 holds money too, both holds are counted', () => {
    const v2Held: Reservation = {
      ...unknownHold,
      runId: 'run-2',
      heldMinor: 1_000,
      lease: { state: 'live' },
      attempt: { id: 'att-2', state: 'dispatched' },
    };
    const story = storyOf([unknownHold, v2Held]);
    expect(story.state).toBe('unknown-outcome');
    expect(story.heldMinor).toBe(3_500);
  });

  it('REVIEW-3A-S1: the pane offers the outcome and the write-off for v1’s attempt', async () => {
    const page = await pane({
      lineages: [lineage({ versions: [v2, v1], reservations: [unknownHold] })],
      onOutcome: ignore,
      onWriteOff: ignore,
    });
    expect(page.find('[data-agent="unknown-outcome"]')).not.toBeNull();
    expect(page.find('[data-agent="write-off"]')).not.toBeNull();
  });
});
