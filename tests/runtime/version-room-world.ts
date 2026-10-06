// SPDX-License-Identifier: AGPL-3.0-only
//
// The steps the version-room proofs take (`replacement-within-the-version-room`):
// calls on a hold, a worker stopped, a historical timestamp, AW-05's stop and
// top-up, and the money a pickup must leave adding up.

import { randomUUID } from 'node:crypto';
import { raiseBudgetWait, sweepModelCalls } from '../../packages/core-custody/src/index.ts';
import { readMigrations } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  appliedDetail,
  asPerson,
  capCommitted,
  liveWork,
  rows,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';

/** A model call on the hold, settled at `minor`, as the broker records one. */
export async function spend(s: Schedules, reservationId: unknown, minor: number): Promise<void> {
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, observed_minor,
        actual_minor, ended_at)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'replacement_room_spend', 'replay', 'local', 'replay', 'settled', $3, $3, $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, randomUUID(), minor],
  );
}

/** A model call on the hold sent and never settled: an unknown liability at its `reserved`. */
export async function unknownCall(
  s: Schedules,
  reservationId: unknown,
  reserved: number,
): Promise<void> {
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, unknown_since)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'replacement_room_unknown', 'replay', 'local', 'replay', 'liability_unknown', $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, randomUUID(), reserved],
  );
}

/** A model call the broker sent on the hold under its lease, never answered; its id. */
export async function dispatchedCall(
  s: Schedules,
  reservationId: unknown,
  reserved: number,
): Promise<string> {
  const id = randomUUID();
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor, started_at)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'written_off_dispatched', 'replay', 'local', 'replay', 'dispatched', $3,
            clock_timestamp()
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, id, reserved],
  );
  return id;
}

/** A model call the broker reserved on the hold under its lease and never sent; its id. */
export async function unsentCall(
  s: Schedules,
  reservationId: unknown,
  reserved: number,
): Promise<string> {
  const id = randomUUID();
  await s.db.admin.execute(
    `insert into public.model_calls
       (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
        route_key, route_reach, credential_kind, state, reserved_minor)
     select r.business_id, $2, r.run_id, a.step_id, r.lease_id, r.version_id, r.id,
            'replacement_room_unsent', 'replay', 'local', 'replay', 'reserved', $3
       from public.reservations r
       join public.attempts a on a.business_id = r.business_id and a.reservation_id = r.id
      where r.id = $1`,
    [reservationId, id, reserved],
  );
  return id;
}

/** The lease-expiry sweep's pass over the business's model calls. */
export async function sweep(s: Schedules): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
}

/** The model call's state. */
export async function callState(s: Schedules, callId: string): Promise<string | undefined> {
  const [call] = await rows<{ state: string }>(
    s,
    'select state from public.model_calls where business_id = $1 and id = $2',
    [s.business, callId],
  );
  return call?.state;
}

/** A manager revokes the worker's delegation: the hold is classified at its calls' spend. */
export async function stopWorker(s: Schedules, picked: Detail): Promise<void> {
  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: picked['delegationId'],
  });
  appliedDetail(revoked, 'delegation.revoke');
}

/** The worker's lease and delegation run out: the next pickup fences it and closes its hold. */
export async function expireLease(s: Schedules, picked: Detail): Promise<void> {
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() - interval '1 second' where id = $1`,
    [picked['leaseId']],
  );
  await s.db.admin.execute(
    'update public.delegations set expires_at = clock_timestamp() where id = $1',
    [picked['delegationId']],
  );
}

export interface Hold {
  readonly id: string;
  readonly state: string;
  readonly held: string;
  readonly actual: string | null;
}

export async function holdsOf(s: Schedules, versionId: unknown): Promise<readonly Hold[]> {
  return await rows<Hold>(
    s,
    `select id, state, held_minor::text as held, actual_minor::text as actual
       from public.reservations where business_id = $1 and version_id = $2
      order by created_at, id`,
    [s.business, versionId],
  );
}

/** The historical state: `later` stamped one second before `earlier`. */
export async function stampBefore(s: Schedules, earlier: unknown, later: unknown): Promise<void> {
  await s.db.admin.execute(
    `update public.reservations set created_at = (
       select created_at - interval '1 second' from public.reservations
        where business_id = $1 and id = $2)
      where business_id = $1 and id = $3`,
    [s.business, earlier, later],
  );
}

/** Live work on a 500 version, its envelope raised to 1000 so only the version bounds a hold. */
export async function roomyWork(
  s: Schedules,
): Promise<{ work: Work; versionId: unknown; first: unknown }> {
  const work = await liveWork(s, `replacement room ${randomUUID()}`, 500);
  await s.db.admin.execute(
    `update public.task_envelopes set maximum_minor = 1000
      where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
  return { work, versionId: work.proposal['versionId'], first: work.decision['reservationId'] };
}

/** The run the hold belongs to, and its latest ask. */
export async function askOf(
  s: Schedules,
  reservationId: unknown,
): Promise<{ readonly runId: string; readonly askId: string | undefined }> {
  const [found] = await rows<{ run_id: string; ask_id: string | null }>(
    s,
    `select r.run_id, (select k.id from public.budget_asks k
                        where k.business_id = r.business_id and k.run_id = r.run_id
                        order by k.ask_number desc limit 1) as ask_id
       from public.reservations r where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId],
  );
  if (found === undefined) throw new Error('askOf: no hold');
  return { runId: found.run_id, askId: found.ask_id ?? undefined };
}

/** A person tops the run's latest ask up by `amount` through the command entry. */
export async function topUp(
  s: Schedules,
  work: Work,
  reservationId: unknown,
  amount: number,
): Promise<Awaited<ReturnType<typeof asPerson>>> {
  const { runId, askId } = await askOf(s, reservationId);
  return await asPerson(s, {
    command: 'run.top_up',
    operationId: randomUUID(),
    recordId: work.taskId,
    runId,
    askId,
    amountMinor: amount,
    currency: 'AUD',
  });
}

/**
 * AW-05's stop and top-up on the first hold: a call reaching its ceiling stops
 * the run with the hold kept, and the person tops it up by `amount`. The
 * top-up moves the hold's spend to the envelope's actual and leaves the hold
 * held at its ceiling plus the amount less that spend.
 */
export async function stopAndTopUp(
  s: Schedules,
  work: Work,
  reservationId: unknown,
  amount: number,
): Promise<void> {
  const [hold] = await rows<{ run_id: string; spent: string }>(
    s,
    `select r.run_id, (select coalesce(sum(c.actual_minor), 0) from public.model_calls c
                        where c.business_id = r.business_id and c.reservation_id = r.id)::text as spent
       from public.reservations r where r.business_id = $1 and r.id = $2`,
    [s.business, reservationId],
  );
  if (hold === undefined) throw new Error('stopAndTopUp: no hold');
  await s.db.app.withBusiness(s.business, async (tx) => {
    const wait = await raiseBudgetWait(tx, {
      runId: hold.run_id,
      leaseId: String(work.picked['leaseId']),
      delegationId: String(work.picked['delegationId']),
      reservationId: String(reservationId),
      versionId: String(work.proposal['versionId']),
      ceilingMinor: 500,
      spentMinor: Number(hold.spent),
    });
    if (!wait.raised) throw new Error('stopAndTopUp: no ask raised');
  });
  appliedDetail(await topUp(s, work, reservationId, amount), 'run.top_up');
}

/** The envelope's figures. */
export async function envelopeOf(s: Schedules, work: Work): Promise<unknown> {
  return await rows(
    s,
    `select maximum_minor::text as maximum, held_minor::text as held, actual_minor::text as actual
       from public.task_envelopes where business_id = $1 and task_id = $2`,
    [s.business, work.taskId],
  );
}

/** The state the stopped hold's top-up recorded it in (`budget_answers.hold_state`). */
export async function holdStateOf(s: Schedules, reservationId: unknown): Promise<unknown> {
  return await rows(
    s,
    `select a.hold_state from public.budget_answers a
       join public.budget_asks k on k.business_id = a.business_id and k.id = a.ask_id
      where a.business_id = $1 and k.reservation_id = $2 and a.kind = 'top_up'`,
    [s.business, reservationId],
  );
}

/**
 * The database as an upgrade from before `hold_state` finds it: the column
 * dropped, then its migration applied again over the rows already there.
 */
export async function asBeforeHoldState(s: Schedules): Promise<void> {
  const migration = readMigrations('migrations').find((m) =>
    m.version.endsWith('_budget_answer_hold_state'),
  );
  if (migration === undefined) throw new Error('asBeforeHoldState: no hold_state migration');
  await s.db.admin.execute('alter table public.budget_answers drop column hold_state');
  for (const statement of migration.statements) {
    // eslint-disable-next-line no-await-in-loop -- one statement at a time, in the migration's order
    await s.db.admin.execute(statement);
  }
}

/** The money a refusal must leave alone: every hold, the envelope and the cap. */
export async function moneyOf(s: Schedules, work: Work, versionId: unknown): Promise<unknown> {
  return {
    holds: await holdsOf(s, versionId),
    envelope: await envelopeOf(s, work),
    cap: await capCommitted(s),
  };
}

/** What the version has committed: its active holds whole, and its closed ones at their spend. */
export const committed = (holds: readonly Hold[]): number =>
  holds.reduce(
    (sum, hold) =>
      sum +
      (['held', 'quarantined'].includes(hold.state) ? Number(hold.held) : Number(hold.actual ?? 0)),
    0,
  );
