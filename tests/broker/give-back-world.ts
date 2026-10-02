// SPDX-License-Identifier: AGPL-3.0-only
//
// The give-back cases' shared half (SL11-29 FIXMONEY, SL11-30 GIVEBACK): a
// broker whose call waits at a gate while the run stops, and the rows that
// show what the envelope counts for it.

import { expect } from 'vitest';
import type { BudgetAnswerRequest } from '../../packages/core-runtime/src/index.ts';
import { rows, type Schedules, type Work } from '../runtime/schedules-harness.ts';
import { s } from './broker-world.ts';

export { gated } from './broker-world.ts';

export const reservationOf = (work: Work): string => String(work.decision['reservationId']);

/** The envelope's actual for the work's first hold, read as the administrator. */
export const envelopeActual = async (work: Work): Promise<number> => {
  const [row] = await rows<{ actual: string }>(
    s,
    `select e.actual_minor::text as actual from public.task_envelopes e
       join public.reservations r on r.envelope_id = e.id where r.id = $1`,
    [reservationOf(work)],
  );
  return Number(row?.actual);
};

/** What the call came to once it ended: its actual, or nothing when it was released. */
interface Ended {
  readonly state: string;
  readonly reserved: string;
  readonly came_to: string;
}

export const calls = async (work: Work): Promise<readonly Ended[]> =>
  await rows<Ended>(
    s,
    `select state, reserved_minor::text as reserved,
            (case when state = 'settled' then actual_minor else 0 end)::text as came_to
       from public.model_calls where reservation_id = $1 and state <> 'refused'
      order by accepted_at`,
    [reservationOf(work)],
  );

export const dispatched = async (work: Work): Promise<void> => {
  await expect
    .poll(async () => (await calls(work)).map((one) => one.state), { timeout: 5_000 })
    .toContain('dispatched');
};

export const runOf = async (work: Work): Promise<string> => {
  const [run] = await rows<{ id: string }>(
    s,
    'select run_id as id from public.reservations where id = $1',
    [reservationOf(work)],
  );
  return String(run?.id);
};

/** The business's decider answering a budget stop. */
export const decider = (on: Schedules, runId: string): BudgetAnswerRequest => ({
  runId: runId,
  caller: { kind: 'person', personId: on.decider.personId, actorId: on.decider.actorId },
  subjects: [
    { kind: 'person', id: on.decider.personId },
    { kind: 'actor', id: on.decider.actorId },
  ],
});
