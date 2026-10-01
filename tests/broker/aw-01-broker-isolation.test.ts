// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01 on the database, continued from aw-01-broker.test.ts: unknown liability
// held by the lease-expiry sweep, the copy register, and the three isolation
// crossings.

import { expect, it as vitestIt } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  callModel,
  promptCopyRegistered,
  sweepModelCalls,
} from '../../packages/core-custody/src/index.ts';
import {
  approve,
  createTask,
  freshPurpose,
  liveWork,
  openSchedules,
  propose,
} from '../runtime/schedules-harness.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { insertLogin } from '../identity/fixture.ts';
import { statusOf } from '../../packages/core-records/src/register.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  noDatabase,
  useBrokerWorld,
  PLANTED_PROMPT,
  s,
  world,
  broker,
  stepOf,
  requestFor,
  call,
  rowsOf,
  callCount,
  caller,
} from './broker-world.ts';

/** Every case needs the database; without one the file is skipped. */
const it = noDatabase ? vitestIt.skip : vitestIt;

useBrokerWorld('aw01isolation');

it('AW-01 unknown liability held: the sweep holds a started call and releases one never sent', async () => {
  const work = await liveWork(s, 'swept', 2_000);
  const step = await stepOf(work);
  const [started, unsent] = [randomUUID(), randomUUID()];
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const [id, state] of [
      [started, 'dispatched'],
      [unsent, 'reserved'],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      await tx.query(
        `insert into public.model_calls
           (business_id, id, run_id, step_id, lease_id, version_id, reservation_id, operation_key,
            state, reserved_minor, route_key, route_reach, credential_kind, started_at)
         select l.business_id, $2, l.run_id, $3, l.id, r.version_id, r.id, 'model.replay_compose',
                $4, 500, 'replay', 'cloud', 'api_key', case when $4 = 'dispatched' then clock_timestamp() end
           from public.leases l join public.reservations r on r.id = l.reservation_id
          where l.business_id = $1 and l.id = $5`,
        [tx.businessId, id, step, state, work.picked['leaseId']],
      );
    }
  });
  await s.db.admin.execute(
    `update public.leases set expires_at = clock_timestamp() where id = $1`,
    [work.picked['leaseId']],
  );
  const swept = await s.db.app.withBusiness(s.business, async (tx) => await sweepModelCalls(tx));
  expect(swept).toEqual({ held: 1, released: 1 });
  expect(await rowsOf(started)).toMatchObject([
    { state: 'liability_unknown', reserved_minor: '500' },
  ]);
  expect(await rowsOf(unsent)).toMatchObject([{ state: 'released' }]);
});

it('AW-01 copy register: every sent prompt was registered first, and a registration is never rewritten', async () => {
  world.provider.mode('answer');
  expect((await call(await liveWork(s, `a registered copy ${PLANTED_PROMPT}`, 2_000))).ok).toBe(
    true,
  );
  const sent = await s.db.admin.execute<{ id: string }>(
    `select id from public.model_calls where state = 'settled' and business_id = $1`,
    [s.business],
  );
  expect(sent.length).toBeGreaterThan(0);
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const { id } of sent) {
      // eslint-disable-next-line no-await-in-loop
      expect(await promptCopyRegistered(tx, id)).toBe(true);
    }
    expect(await promptCopyRegistered(tx, randomUUID())).toBe(false);
  });
  await expect(
    s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await tx.query(
          `update public.copy_registrations set retention_class = 'record' where business_id = $1`,
          [tx.businessId],
        ),
    ),
  ).rejects.toThrow(/permission denied/u);
  // Past the grant, the table itself refuses: even the owner cannot rewrite one.
  await expect(
    s.db.admin.execute(`update public.copy_registrations set retention_class = 'record'`),
  ).rejects.toThrow(/append only/u);
  await expect(s.db.admin.execute(`delete from public.copy_registrations`)).rejects.toThrow(
    /append only/u,
  );
});

/** Crossing 1: another business's lease presented here, and our lease presented there. */
async function acrossBusiness(
  mine: Awaited<ReturnType<typeof liveWork>>,
  refusedAlike: (result: unknown) => void,
): Promise<void> {
  const bravo = await openSchedules('aw01bravo', 1_000_000);
  try {
    const theirs = await liveWork(bravo, 'bravo work', 2_000);
    const [theirStep] = await bravo.db.admin.execute<{ id: string }>(
      `select st.id from public.planned_steps st join public.leases l on l.run_id = st.run_id where l.id = $1`,
      [theirs.picked['leaseId']],
    );
    refusedAlike(
      await call(mine, {
        leaseId: String(theirs.picked['leaseId']),
        fence: Number(theirs.picked['fence']),
        stepId: String(theirStep?.id),
      }),
    );
    refusedAlike(
      await callModel(
        s.db.app,
        s.business,
        { ...caller(mine), actorId: bravo.agentActorId },
        requestFor(mine),
        broker,
      ),
    );
  } finally {
    await bravo.db.drop();
  }
}

/** Crossing 3's caller: another person's agent holding a live delegation of its own. */
async function otherAgentUnderLiveDelegation(): Promise<string> {
  const other = await enrol(s.db.app, s.business, 'other-decider');
  const otherSubject = `agent-${randomUUID()}`;
  const otherAgent = randomUUID();
  await s.db.app.withBusiness(s.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // eslint-disable-next-line no-await-in-loop
      await grantTo(tx, other, action, undefined, true);
    }
    await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
      s.business,
      otherAgent,
    ]);
    await tx.query(
      `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
       values ($1, $2, $3, $4, $5)`,
      [s.business, randomUUID(), await insertLogin(tx, otherSubject), otherAgent, other.actorId],
    );
  });
  const theirTask = await createTask(s, 'the other agent task');
  const decision = await approve(
    s,
    await propose(s, theirTask, { maximumMinor: 2_000, purpose: freshPurpose() }),
  );
  const picked = await executeAgentCommand(
    s.db.app,
    s.business,
    { provider: 'supabase', subject: otherSubject },
    undefined,
    {
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId: decision['reservationId'],
      leaseSeconds: 600,
    } as never,
  );
  expect(isCommandRefusal(picked as object)).toBe(false);
  const live = await s.db.admin.execute<{ n: string }>(
    `select count(*)::text as n from public.delegations
      where agent_actor_id = $1 and revoked_at is null and expires_at > now()`,
    [otherAgent],
  );
  expect(live[0]?.n).toBe('1');
  return otherAgent;
}

it('AW-01 isolation: another business, another client, another person under a live delegation', async () => {
  world.provider.mode('answer');
  const mine = await liveWork(s, 'alpha work', 2_000);
  await stepOf(mine);
  const madeUp = await call(mine, { leaseId: randomUUID() });
  const before = await callCount();
  const seen = world.provider.seen.length;
  const refusedAlike = (result: unknown): void => {
    expect(result).toEqual(madeUp);
    expect(result).toEqual({ ok: false, code: 'LEASE_NOT_OWNED', callId: null });
  };
  expect(statusOf('LEASE_NOT_OWNED')).toBe(403);

  // 1. Another business: its lease, presented here, reads as made up; and ours, there.
  await acrossBusiness(mine, refusedAlike);

  // 2. Another client in the same business: client X, on its own shared task, presents the lease on client Y's.
  const taskX = await createTask(s, 'client X task');
  // As in CQ-7: a person outside the staff holding one record-scoped grant on its own task (R4).
  const clientX = await enrol(s.db.app, s.business, 'client-x');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, clientX, 'read', { kind: 'record', id: taskX });
  });
  refusedAlike(
    await callModel(
      s.db.app,
      s.business,
      { ...caller(mine), actorId: clientX.actorId },
      requestFor(mine),
      broker,
    ),
  );

  // 3. Another person's agent, under its own live delegation, presents our agent's lease.
  const otherAgent = await otherAgentUnderLiveDelegation();
  refusedAlike(
    await callModel(
      s.db.app,
      s.business,
      { ...caller(mine), actorId: otherAgent },
      requestFor(mine),
      broker,
    ),
  );

  // Nothing was written or sent for any crossing, and our own call still works.
  expect(await callCount()).toBe(before);
  expect(world.provider.seen.length).toBe(seen);
  expect((await call(mine)).ok).toBe(true);
});

it('AW-01 canary: the planted key and the planted prompt reach no row, audit payload or answer', async () => {
  const tables = await s.db.admin.execute<{ dump: string }>(
    `select coalesce(string_agg(t::text, ' '), '') as dump from (
       select row_to_json(m)::text as t from public.model_calls m
       union all select row_to_json(a)::text from public.audit_events a
       union all select row_to_json(c)::text from public.copy_registrations c) rows`,
  );
  const dump = tables[0]?.dump ?? '';
  expect(dump).not.toContain(world.canary);
  expect(dump).not.toContain(PLANTED_PROMPT);
  expect(world.custody.stderr()).not.toContain(world.canary);
  // The provider did receive the prompt: the search above is not vacuous.
  expect(world.provider.seen.some((request) => request.body.includes(PLANTED_PROMPT))).toBe(true);
});
