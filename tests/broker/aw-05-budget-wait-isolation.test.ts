// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-05 isolation: the budget wait is raised only on the caller's own run.
// Three real crossings present a lease whose run sits at its ceiling: another
// business's agent, a client-scoped person of the same business, and another
// person's agent under its own live delegation. Each is refused as a made-up
// lease is, and none stops the run, asks, or ends the lease. Another business
// reads, counts and plants no ask of this one's. The run's own agent then
// stops it, once.
//
// The same-business crossing is a person holding one record-scoped grant on
// their own task (as AW-01 isolation and CQ-7 do); a client record is C32's
// (LEANS-ON SL09-B), and the crossing moves onto it at the rebase.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { callModel, type ModelCallResult } from '../../packages/core-custody/src/index.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import {
  approve,
  createTask,
  freshPurpose,
  liveWork,
  propose,
  seedSchedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import {
  broker,
  call,
  caller,
  noDatabase,
  requestFor,
  s,
  stepOf,
  useBrokerWorld,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw05iso');

/** Below the replay operation's priced maximum (500): any call stops this run. */
const AT_THE_CEILING = 400;

const refusedAlike = (result: ModelCallResult): void => {
  expect(result.ok).toBe(false);
  expect(result.ok ? null : result.code).toBe('LEASE_NOT_OWNED');
};

/** Another person of the business, with their own agent holding a live delegation on their own work. */
async function otherPersonsAgent(): Promise<string> {
  const other = await enrol(s.db.app, s.business, 'aw05-other-decider');
  const subject = `agent-${randomUUID()}`;
  const agent = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action, undefined, true);
    }
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      s.business,
      agent,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [s.business, randomUUID(), await insertLogin(tx, subject), agent, other.actorId],
    );
  });
  const theirs = await createTask(s, 'aw05 the other agent task');
  const decision = await approve(
    s,
    await propose(s, theirs, { maximumMinor: AT_THE_CEILING, purpose: freshPurpose() }),
  );
  const picked = await executeAgentCommand(
    s.db.app,
    s.business,
    { provider: 'supabase', subject },
    undefined,
    {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decision['reservationId'],
      leaseSeconds: 600,
    } as never,
  );
  expect(isCommandRefusal(picked as object)).toBe(false);
  return agent;
}

const waitOf = async (leaseId: unknown) =>
  (
    await s.db.admin.execute<{ run: string; lease: string; asks: string }>(
      `select run.state as run, l.state as lease,
              (select count(*) from public.budget_asks a where a.run_id = run.id)::text as asks
         from public.leases l join public.planned_runs run on run.id = l.run_id
        where l.id = $1`,
      [leaseId],
    )
  )[0];

/** The lease's holder swapped for `actorId`, in `businessId`: refused as a made-up lease, and the run untouched. */
async function crossing(mine: Work, businessId: BusinessId, actorId: string): Promise<void> {
  refusedAlike(
    await callModel(s.db.app, businessId, { ...caller(mine), actorId }, requestFor(mine), broker),
  );
  expect(await waitOf(mine.picked['leaseId'])).toEqual({
    run: 'claimed',
    lease: 'live',
    asks: '0',
  });
}

/** A person of the same business, holding one record-scoped grant on their own task. */
async function recordScopedPerson(): Promise<string> {
  const ownTask = await createTask(s, 'aw05 client X task');
  const clientX = await enrol(s.db.app, s.business, 'aw05-client-x');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, clientX, 'read', { kind: 'record', id: ownTask });
  });
  return clientX.actorId;
}

/** Bravo reads and counts none of alpha's asks, and cannot plant one on alpha's run. */
async function bravoSeesNone(bravo: BusinessId, mine: Work): Promise<void> {
  const [alphaAsk] = await s.db.admin.execute<Record<string, unknown>>(
    `select a.* from public.budget_asks a join public.leases l on l.run_id = a.run_id where l.id = $1`,
    [mine.picked['leaseId']],
  );
  const asBravo = async (sql: string, params: readonly unknown[]): Promise<string> =>
    await s.db.app
      .withBusiness(bravo, async (tx) => JSON.stringify(await tx.query(sql, params)))
      .catch((error: unknown) => String((error as { code?: string }).code));
  expect(await asBravo(`select count(*)::int as n from public.budget_asks`, [])).toBe('[{"n":0}]');
  const plant = `insert into public.budget_asks
       (business_id, id, run_id, reservation_id, lease_id, decision_id, ask_number, kind,
        ceiling_minor, spent_minor, currency)
     values ($1, $2, $3, $4, $5, $6, 2, 'stop', 400, 0, 'AUD')`;
  const ids = ['run_id', 'reservation_id', 'lease_id', 'decision_id'].map((key) => alphaAsk?.[key]);
  expect(await asBravo(plant, [s.business, randomUUID(), ...ids])).toBe('42501');
}

it('AW-05 isolation', async () => {
  const mine = await liveWork(s, 'aw05 alpha at its ceiling', AT_THE_CEILING);
  await stepOf(mine);
  // 1. Another business's agent; 2. a record-scoped person of this business;
  // 3. another person's agent under its own live delegation.
  const bravo = await seedSchedules(s.db, 'aw05bravo', 1_000_000);
  await crossing(mine, bravo.business, bravo.agentActorId);
  await crossing(mine, s.business, await recordScopedPerson());
  await crossing(mine, s.business, await otherPersonsAgent());

  // The run's own agent stops it, once.
  expect((await call(mine)).ok).toBe(false);
  expect(await waitOf(mine.picked['leaseId'])).toEqual({
    run: 'waiting_budget',
    lease: 'released',
    asks: '1',
  });
  await bravoSeesNone(bravo.business, mine);
});
