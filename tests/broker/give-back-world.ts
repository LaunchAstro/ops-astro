// SPDX-License-Identifier: AGPL-3.0-only
//
// The give-back cases' shared half (SL11-29 FIXMONEY, SL11-30 GIVEBACK): a
// broker whose call waits at a gate while the run stops, and the rows that
// show what the envelope counts for it.

import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from 'vitest';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
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

/**
 * `on` with its application on a connection of its own, whose settlement
 * stops once `lockCall` holds its locks, envelope first and reservation last,
 * before it reads the call's row, until `resume`: a close on the world's own
 * connection can be seen waiting on the envelope.
 */
export function heldAtEnvelope(on: Schedules): {
  readonly on: Schedules;
  readonly reached: Promise<void>;
  readonly resume: () => void;
  readonly close: () => Promise<void>;
} {
  const own = connect(on.db.appUrl);
  let reach: (() => void) | undefined;
  let resume: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const app: Database = {
    ...own,
    withBusiness: async (businessId, run) =>
      await own.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
              const found = await tx.query<Row>(sql, parameters);
              if (sql.startsWith('select 1 from public.reservations')) {
                reach?.();
                await gate;
              }
              return found;
            },
          }),
      ),
  };
  return {
    on: { ...on, db: { ...on.db, app } },
    reached,
    resume: () => resume?.(),
    close: own.close,
  };
}

/**
 * `resume` once another backend in `on`'s database waits for an envelope lock
 * (`for update of e`); whether one did within five seconds.
 */
export async function resumeOnceBlocked(on: Schedules, resume: () => void): Promise<boolean> {
  try {
    for (let tries = 0; tries < 100; tries += 1) {
      // Sequential polls: each reads the database as it now stands.
      // eslint-disable-next-line no-await-in-loop
      const [row] = await on.db.admin.execute<{ readonly waiting: boolean }>(
        `select exists(select 1 from pg_stat_activity
                        where datname = current_database() and wait_event_type = 'Lock'
                          and query like '%for update of e%') as waiting`,
      );
      if (row?.waiting === true) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    return false;
  } finally {
    resume();
  }
}
