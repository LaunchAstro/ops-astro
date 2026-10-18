// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R1, the drop at settlement (ruling R1B-A, 18 October 2026). A model
// call through the real agent door meets a provider that is down. Settlement
// holds the call unknown and its stop ends the attempt, `unknown_provider_outcome
// / LIABILITY_UNKNOWN`, so the worker can no longer hand back `dropped`. The
// same transaction records T3e1's drop: the cause on the attempt, `dropped` on
// the run's progress, and a person told through the outage report. model.call
// gives the broker that writer; without it the attempt keeps no cause and
// nobody is told. Control: a connection cut records its own cause, never the
// provider's.

import { expect, it as vitestIt } from 'vitest';
import { liveWork, rows, type Work } from '../runtime/schedules-harness.ts';
import {
  asAgent,
  callBody,
  leaseOf,
  noDatabase,
  s,
  signedIn,
  useDoorWorld,
  world,
} from './run-stop-door-world.ts';
import { attemptOfLease, outcomesOfAttempt } from './run-outcomes-read.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useDoorWorld('r1drop');

const CASES = [
  { mode: 'unavailable', cause: 'provider_unavailable' },
  { mode: 'cut', cause: 'connection_lost' },
] as const;

async function recorded(work: Work) {
  const { attemptId } = await attemptOfLease(s.db.admin, s.business, leaseOf(work));
  return {
    outcomes: await outcomesOfAttempt(s.db.admin, s.business, attemptId),
    attempts: await rows(
      s,
      'select state, drop_cause from public.attempts where business_id = $1 and id = $2',
      [s.business, attemptId],
    ),
    progress: await rows(
      s,
      `select detail->>'cause' as cause from public.run_events
        where business_id = $1 and task_id = $2 and kind = 'dropped'`,
      [s.business, work.taskId],
    ),
    told: await rows(
      s,
      `select r.cause from public.outage_reports r
         join public.outage_runs o on o.business_id = r.business_id and o.outage_id = r.id
        where r.business_id = $1 and o.task_id = $2`,
      [s.business, work.taskId],
    ),
  };
}

it.each(CASES)(
  'a provider drop ($cause) at settlement records the drop with its stop, and a person is told',
  async ({ mode, cause }) => {
    const work = await liveWork(s, `r1 drop ${mode}`, 2_000);
    world.provider.mode(mode);
    const answer = await asAgent('/model/call', work, callBody(work), await signedIn());
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('LIABILITY_UNKNOWN');
    const after = await recorded(work);
    expect(after.outcomes).toMatchObject([
      { outcome: 'unknown_provider_outcome', end_code: 'LIABILITY_UNKNOWN', stop_cause: null },
    ]);
    expect(after.attempts).toEqual([{ state: 'liability_unknown', drop_cause: cause }]);
    expect(after.progress).toEqual([{ cause }]);
    expect(after.told).toEqual([{ cause }]);
  },
  60_000,
);
