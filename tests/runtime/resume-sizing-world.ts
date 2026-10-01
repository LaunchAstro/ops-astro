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
export const openAtWhole = async (label: string): Promise<Work> => {
  const work = await liveWork(s, `resize ${label} ${randomUUID()}`, 500);
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

/** Work whose one call is open at its whole hold when its delegation is revoked. */
export const spentWhole = async (label: string): Promise<Work> => {
  const work = await openAtWhole(label);
  await revoke(work);
  return work;
};

export const pickupOf = async (work: Work): ReturnType<typeof asAgent> =>
  await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: work.decision['reservationId'],
    leaseSeconds: 600,
  });

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
