// SPDX-License-Identifier: AGPL-3.0-only
//
// C52-A's run start and C33's limits over C33's world: each business gets an
// active worker, whose actor starts an occurrence's run (AW-01 J), and the
// task spine that run's task lands on. The starter is the product's own
// (`occurrenceRunStarter`), wrapped to list the runs it started. Occurrences
// are seeded in bulk through the owner role to fill a rate or the queue, so a
// case reaches a limit without hundreds of claims.

import { randomUUID } from 'node:crypto';
import { occurrenceRunStarter } from '../../packages/core-commands/src/index.ts';
import {
  waitingOccurrences,
  type RunRequest,
  type RunStarter,
} from '../../packages/core-records/src/index.ts';
import { installSpine } from '../commands/fixture.ts';
import type { FreshDatabase } from '../support/fresh-database.ts';
import type { Approved, AutomationWorld } from './world.ts';

export interface Workers {
  readonly worker: string;
  readonly bravoWorker: string;
}

/** An actor of the business's own worker, active unless asked otherwise. */
export async function insertWorker(
  db: FreshDatabase,
  business: string,
  active = true,
): Promise<string> {
  const id = randomUUID();
  await db.admin.execute(
    `insert into public.actors (business_id, id, kind, active, deactivated_at)
     values ($1, $2, 'worker', $3, case when $3 then null else now() end)`,
    [business, id, active],
  );
  return id;
}

/** Each business's worker and task spine. */
export async function prepareRuns(w: AutomationWorld): Promise<Workers> {
  await installSpine(w.db.app, w.alpha);
  await installSpine(w.db.app, w.bravo);
  return {
    worker: await insertWorker(w.db, w.alpha),
    bravoWorker: await insertWorker(w.db, w.bravo),
  };
}

export interface WorkerStarter {
  readonly runs: RunRequest[];
  readonly start: RunStarter;
}

/** The product's starter for this worker, listing each run it started. */
export function workerStarter(workerActorId: string): WorkerStarter {
  const runs: RunRequest[] = [];
  const real = occurrenceRunStarter(workerActorId);
  return {
    runs,
    async start(tx, run) {
      const answer = await real(tx, run);
      if (typeof answer === 'string') runs.push(run);
      return answer;
    },
  };
}

/** What an occurrence's run writes, counted in every business. */
export interface RunFootprint {
  readonly runs: number;
  readonly pins: number;
  readonly tasks: number;
  readonly audit: number;
}

export async function runFootprint(w: AutomationWorld): Promise<RunFootprint> {
  return {
    runs: await w.count(
      'select count(*) as n from public.planned_runs where origin_occurrence_id is not null',
    ),
    pins: await w.count(
      `select count(*) as n from public.run_definition_pins where ref_kind = 'definition_version'`,
    ),
    tasks: await w.count(
      `select count(*) as n from public.records where data->>'source' = 'system:automation'`,
    ),
    audit: await w.count(
      `select count(*) as n from public.audit_events where command = 'occurrence.run_start'`,
    ),
  };
}

/** Every occurrence run in the business finishes (the agent engine's step). */
export async function finishRuns(w: AutomationWorld, business: string): Promise<void> {
  await w.db.admin.execute(
    `update public.planned_runs set state = 'handed_back'
      where business_id = $1 and origin_occurrence_id is not null`,
    [business],
  );
}

/** The ids a business's worker sees waiting, read on `pool`. */
export async function waitingIn(pool: FreshDatabase['app'], business: string): Promise<string[]> {
  return (await pool.withBusiness(business, (tx) => waitingOccurrences(tx))).map((o) => o.id);
}

/**
 * `n` approved occurrences of the first business's activation, written by the
 * owner role `ago` back: events (with no dispatch, so queued) or due times
 * far from the world's own.
 */
export async function seedApproved(
  w: AutomationWorld,
  approved: Approved,
  n: number,
  { events, ago }: { readonly events: boolean; readonly ago: string },
): Promise<void> {
  await w.db.admin.execute(
    `insert into public.activation_occurrences
       (business_id, id, activation_id, version_id, due_at, event_id, outcome, approval_id,
        recorded_at)
     select $1, gen_random_uuid(), $2, $3,
            case when $6 then null else timestamptz '2031-01-01' + g * interval '1 minute' end,
            case when $6 then 'seeded-' || gen_random_uuid() else null end,
            'approved', $4, now() - $7::interval
       from generate_series(1, $5::int) g`,
    [w.alpha, approved.activation.id, approved.version.id, approved.approval.id, n, events, ago],
  );
}

/** The rolling hour moves on past every occurrence recorded so far. */
export async function hourPasses(w: AutomationWorld): Promise<void> {
  await w.db.admin.execute(
    `update public.activation_occurrences set recorded_at = recorded_at - interval '61 minutes'`,
  );
}
