// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-108.1, security review low on f16527f: the run story reads Done only for
// an explicit `completed` outcome, so an attempt read without the key fails
// closed. Sol's failed-hand-back proof covers the failed value itself.

import { describe, expect, it } from 'vitest';
import { runStories, type RunLineage } from '../../packages/ui/src/index.ts';
import { lineage } from './mp-6-1-agent-fixtures.tsx';

type Reservation = RunLineage['reservations'][number];

/** The reservation as the server's hand-back leaves it, its attempt's outcome given. */
function handedBack(outcome: string | null): Reservation {
  const attempt = { state: 'abandoned', outcome };
  return {
    state: 'abandoned',
    heldMinor: 2_500,
    actualMinor: null,
    classifiedCause: 'handback_completed',
    lease: { state: 'released' },
    attempt,
  };
}

const stateOf = (reservation: Reservation) =>
  runStories([lineage({ state: 'live', reservations: [reservation] })]).at(-1)!;

describe('OW-108.1 a hand-back story without an outcome', () => {
  it('an attempt read without its outcome never reads as done', () => {
    // A narrower read or a cached projection that drops the key must fail closed.
    const { outcome: _dropped, ...attempt } = { state: 'abandoned', outcome: 'completed' };
    const story = stateOf({ ...handedBack('completed'), attempt } as unknown as Reservation);
    expect([story.state, story.tone]).toStrictEqual(['dropped', 'bad']);
  });
});
