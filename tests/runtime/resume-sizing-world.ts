// SPDX-License-Identifier: AGPL-3.0-only
//
// The resume-sizing cases' shared half (SL11-29 FIXMONEY): a step's holds, a
// manager's revoke that classifies them, a call open at its whole hold, and
// the pickup and asks that follow.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  appliedDetail,
  asAgent,
  asPerson,
  liveWork,
  rows,
  type Work,
} from './schedules-harness.ts';
import { grantTo } from '../commands/fixture.ts';
import { broker, call, s } from '../broker/broker-world.ts';
import {
  mintDelegation,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/index.ts';
import { hold, type Held } from '../support/lock-wait-race.ts';

interface Hold {
  readonly id: string;
  readonly state: string;
  readonly held: string;
  readonly actual: string | null;
}

export const holdsOn = async (work: Work): Promise<readonly Hold[]> =>
  await rows<Hold>(
    s,
    `select r.id, r.state, r.held_minor::text as held, r.actual_minor::text as actual
       from public.reservations r
       join public.reservations old on old.run_id = r.run_id
      where old.id = $1 order by r.created_at, r.id`,
    [work.decision['reservationId']],
  );

/** A manager revokes the worker's delegation: its hold is classified and its run goes back to planned. */
export const revoke = async (work: Work): Promise<void> => {
  await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'manage'));
  const revoked = await asPerson(s, {
    command: 'delegation.revoke',
    operationId: randomUUID(),
    delegationId: work.picked['delegationId'],
  });
  appliedDetail(revoked, 'delegation.revoke');
};

/** Work whose one call is open at the replay maximum of 500, its whole hold, never answered. */
export const openAtWhole = async (label: string): Promise<Work> =>
  await holdOpenAtWhole(await liveWork(s, `resize ${label} ${randomUUID()}`, 500));

/** `work`, held at 500, with its one call left open at that whole hold. */
export const holdOpenAtWhole = async (work: Work): Promise<Work> => {
  const silent = {
    ...broker,
    custody: { ...broker.custody, dispatch: async () => await new Promise<never>(() => {}) },
  };
  void call(work, {}, silent);
  const openCall = async () =>
    await rows<{ state: string }>(
      s,
      'select state from public.model_calls where reservation_id = $1',
      [work.decision['reservationId']],
    );
  await expect.poll(openCall, { timeout: 5_000 }).toMatchObject([{ state: 'dispatched' }]);
  return work;
};

/**
 * Work whose one call settled at its maximum, its whole hold: a provider billing
 * the whole of it. The replay provider never answers that high, so the open
 * call's row is moved as the broker's settle moves it.
 */
export const settledAtWhole = async (label: string): Promise<Work> =>
  await settleAtWhole(await openAtWhole(label));

/** `work`'s open call settled at its maximum, as `settledAtWhole` settles it. */
export const settleAtWhole = async (work: Work): Promise<Work> => {
  await s.db.admin.execute(
    `update public.model_calls
        set state = 'settled', observed_minor = reserved_minor, actual_minor = reserved_minor,
            drop_state = null, completed_at = clock_timestamp(), ended_at = clock_timestamp()
      where reservation_id = $1 and state = 'dispatched'`,
    [work.decision['reservationId']],
  );
  return work;
};

/**
 * Work whose spend used its whole hold, its delegation then revoked: the
 * classifier settles the hold at that spend (AW-01), and nothing is left to
 * hold for the step.
 */
export const spentWhole = async (label: string): Promise<Work> => {
  const work = await settledAtWhole(label);
  await revoke(work);
  return work;
};

/** The agent's pickup of `work`'s hold, on `database` (the app's own by default), under `operationId`. */
export const pickupOf = async (
  work: Work,
  {
    database = s.db.app,
    operationId = randomUUID(),
  }: { database?: Database; operationId?: string } = {},
): ReturnType<typeof asAgent> =>
  await asAgent(
    s,
    {
      command: 'task.pickup',
      operationId,
      reservationId: work.decision['reservationId'],
      leaseSeconds: 600,
    },
    undefined,
    database,
  );

/**
 * Another live delegation of the agent's for `work`'s purpose, minted as `work`'s own pickup
 * minted its first, in `tx` when given (left open by the caller), and its id.
 */
export const delegationBeside = async (
  work: Work,
  expiresAt: Date,
  tx?: TenantQuery,
): Promise<string> => {
  const [old] = await rows<{
    agent_actor_id: string;
    delegate_person_id: string;
    minted_by_actor_id: string;
    purpose: string;
    collections: string[];
    actions: Parameters<typeof mintDelegation>[1]['actions'];
  }>(s, 'select * from public.delegations where id = $1', [work.picked['delegationId']]);
  if (old === undefined) throw new Error("Expected the work's first delegation");
  const mint = async (on: TenantQuery) =>
    await mintDelegation(on, {
      agentActorId: old.agent_actor_id,
      delegatePersonId: old.delegate_person_id,
      mintedByActorId: old.minted_by_actor_id,
      purpose: old.purpose,
      collections: old.collections,
      actions: old.actions,
      purposeScope: { kind: 'record', id: work.taskId },
      expiresAt,
    });
  const minted = tx === undefined ? await s.db.app.withBusiness(s.business, mint) : await mint(tx);
  if (!minted.ok) throw new Error(`the mint was refused: ${minted.refusal.code}`);
  return minted.value.delegation.id;
};

/** A delegation's row held `for update` on a connection of its own, `last` run before it commits. */
export const holdDelegation = async (
  id: string,
  last?: (
    execute: (sql: string, parameters: readonly unknown[]) => Promise<unknown>,
  ) => Promise<void>,
): Promise<Held> =>
  await hold(
    s.db,
    async (execute) => {
      const held = await execute('select id from public.delegations where id = $1 for update', [
        id,
      ]);
      if (held.length === 0) throw new Error('holdDelegation: no delegation to hold');
    },
    last === undefined ? undefined : async (execute) => await last(execute as never),
  );

interface Ask {
  readonly run_state: string;
  readonly ceiling: string;
  readonly spent: string;
  readonly kind: string;
}

export const asksOn = async (work: Work): Promise<readonly Ask[]> =>
  await rows<Ask>(
    s,
    `select run.state as run_state, k.ceiling_minor::text as ceiling, k.spent_minor::text as spent,
            k.kind
       from public.budget_asks k join public.planned_runs run on run.id = k.run_id
      where k.reservation_id = $1`,
    [work.decision['reservationId']],
  );
