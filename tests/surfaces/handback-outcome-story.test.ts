// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-108.1: a failed hand-back releases its hold under `handback_completed`
// exactly as a completed one does, and a spent one settles `actual`, so the run
// story reads the attempt's recorded outcome. Only an explicit `completed` is
// Done; every other value the database allows (migrations/0014_runtime_attempts.sql,
// `attempts_outcome_known`), none yet, a missing key and an unexpected value
// read as stopped short, on both paths.

import { describe, expect, it } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import { lineage } from './mp-6-1-agent-fixtures.tsx';

type Reservation = RunLineage['reservations'][number];

/** The attempt with `outcome`, or with no outcome key at all. */
function attemptOf(state: string, outcome: string | null | undefined): Reservation['attempt'] {
  const attempt = outcome === undefined ? { state } : { state, outcome };
  return attempt as Reservation['attempt'];
}

/** The reservation as the server's hand-back releases it. */
function released(outcome: string | null | undefined): Reservation {
  return {
    state: 'abandoned',
    heldMinor: 2_500,
    actualMinor: null,
    classifiedCause: 'handback_completed',
    lease: { state: 'released' },
    attempt: attemptOf('abandoned', outcome),
  };
}

/** A hold that spent, settled `actual` as the classifier settles a hand-back. */
function settled(outcome: string | null | undefined): Reservation {
  return {
    ...released(outcome),
    state: 'actual',
    actualMinor: 900,
    attempt: attemptOf('handed_back', outcome),
  };
}

const stateOf = (reservation: Reservation) =>
  runStories([lineage({ state: 'live', reservations: [reservation] })]).at(-1)!;

describe('OW-108.1 a hand-back story follows the attempt outcome', () => {
  it('only an explicit completed outcome reads Done, released or settled', () => {
    for (const shape of [released, settled]) {
      expect(stateOf(shape('completed')).state).toBe('done');
      for (const outcome of ['failed', 'abandoned', 'unknown', null, undefined, 'surprise']) {
        const story = stateOf(shape(outcome));
        expect([shape.name, outcome, story.state, story.tone]).toStrictEqual([
          shape.name,
          outcome,
          'dropped',
          'bad',
        ]);
      }
    }
  });
});
