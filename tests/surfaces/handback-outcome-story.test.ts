// SPDX-License-Identifier: AGPL-3.0-only
//
// OW-108.1: a failed hand-back releases its hold under `handback_completed`
// exactly as a completed one does, so the run story reads the attempt's
// recorded outcome. Only `completed` is done; every other value the database
// allows (migrations/0014_runtime_attempts.sql, `attempts_outcome_known`),
// none yet, and a value it does not know all read as stopped short.

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

/** A hold settled at its spend, as `budget.ts` settles a hand-back, its outcome given. */
function settled(outcome: string | null): Reservation {
  const attempt = { state: 'settled', outcome };
  return { ...handedBack(outcome), state: 'actual', actualMinor: 900, attempt };
}

const stateOf = (reservation: Reservation) =>
  runStories([lineage({ state: 'live', reservations: [reservation] })]).at(-1)!;

describe('OW-108.1 a hand-back story follows the attempt outcome', () => {
  it('a completed outcome reads Done, released or settled', () => {
    for (const reservation of [handedBack('completed'), settled('completed')]) {
      const story = stateOf(reservation);
      expect([story.state, story.word, story.cancellable]).toStrictEqual(['done', 'Done', false]);
    }
  });

  it('every other outcome, none yet and an unknown value never read as done', () => {
    for (const outcome of ['failed', 'abandoned', 'unknown', null, 'COMPLETED', 'surprise']) {
      for (const reservation of [handedBack(outcome), settled(outcome)]) {
        const story = stateOf(reservation);
        expect([outcome, story.state, story.tone]).toStrictEqual([outcome, 'dropped', 'bad']);
        expect(story.jobs[0]?.state).toBe('failed');
      }
    }
  });

  it('an attempt read without its outcome never reads as done', () => {
    // A narrower read or a cached projection that drops the key must fail closed.
    const { outcome: _dropped, ...attempt } = { state: 'abandoned', outcome: 'completed' };
    const story = stateOf({ ...handedBack('completed'), attempt } as unknown as Reservation);
    expect([story.state, story.tone]).toStrictEqual(['dropped', 'bad']);
  });
});
