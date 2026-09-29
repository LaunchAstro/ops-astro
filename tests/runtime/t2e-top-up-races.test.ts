// SPDX-License-Identifier: AGPL-3.0-only
//
// T2e's races, over a real database: the second approval against a first
// approver's revocation, a first approval that commits while the second is in
// flight, and a late first approver whose grant is mid-revocation. Sol's proofs
// on #130 (80182bf, 40da5a1) are moved here unchanged from t2e-top-up.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/index.ts';
import { topUp as applyTopUp } from '../../packages/core-runtime/src/budget.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { appliedDetail, racer, type Schedules } from './schedules-harness.ts';
import { LARGE, MAXIMUM, openTopUpWorld, topUpBody, type TopUpWorld } from './t2e-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t2e-top-up-races: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('T2e the top-up, races', () => {
  let w: TopUpWorld;
  let s: Schedules;
  let second: Member;
  let planner: Member;
  const topUp: TopUpWorld['topUp'] = async (...args) => await w.topUp(...args);
  const maximumOf: TopUpWorld['maximumOf'] = async (...args) => await w.maximumOf(...args);
  const planned: TopUpWorld['planned'] = async (...args) => await w.planned(...args);

  beforeAll(async () => {
    w = await openTopUpWorld('t2erace');
    ({ s, second, planner } = w);
  }, 180_000);

  afterAll(async () => {
    await w?.s.db.drop();
  });

  it('a first approval revoked before the second decision commits cannot be counted', async () => {
    const first = await enrol(s.db.app, s.business, 'sol-first');
    const grantId = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, first, 'decide', undefined, false, 'billing'),
    );
    const plan = await planned(planner);
    appliedDetail(await topUp(first, plan.taskId, LARGE, MAXIMUM), 'budget.top_up');

    let unblock!: () => void;
    let signal!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      signal = resolve;
    });
    let decisionFinished = false;
    const decision = s.db.app
      .withBusiness(s.business, async (tx) => {
        const intercepted: TenantQuery = {
          businessId: tx.businessId,
          query: async <Row>(
            sql: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> => {
            const answer = await tx.query<Row>(sql, parameters);
            const ids = parameters?.[1];
            if (
              sql.includes('select id from public.grants') &&
              Array.isArray(ids) &&
              ids.includes(grantId)
            ) {
              signal();
              await blocked;
            }
            return answer;
          },
        };
        return await applyTopUp(intercepted, {
          taskId: plan.taskId,
          amountMinor: BigInt(LARGE),
          fromMaximumMinor: BigInt(MAXIMUM),
          personId: second.personId,
          subjects: [
            { kind: 'person', id: second.personId },
            { kind: 'actor', id: second.actorId },
          ],
          collection: 'billing',
        });
      })
      .then((result) => {
        decisionFinished = true;
        return result;
      });
    await reached;
    let revokeFinished = false;
    let revokedBeforeDecision = false;
    const revoker = racer(s);
    const revocation = revoker
      .withBusiness(s.business, async (tx) => {
        await tx.query('update public.grants set revoked_at = now() where id = $1', [grantId]);
      })
      .then(() => {
        revokeFinished = true;
        revokedBeforeDecision = !decisionFinished;
        return undefined;
      });
    let parked = false;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (revokeFinished) break;
      // Poll the exact revocation, rather than assuming a blocked write finished.
      // eslint-disable-next-line no-await-in-loop
      const waiting = await s.db.admin.execute<{ readonly parked: boolean }>(
        `select exists(select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like 'update public.grants set revoked_at = now()%') as parked`,
      );
      if (waiting[0]?.parked === true) {
        parked = true;
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    if (!revokeFinished && !parked)
      throw new Error('revocation did not finish or wait for its grant');
    unblock();
    const outcome = await decision;
    await revocation;
    await revoker.close();
    const applied = outcome.ok && outcome.value.state === 'applied';
    expect({ revokedBeforeDecision, applied }).not.toStrictEqual({
      revokedBeforeDecision: true,
      applied: true,
    });
    if (revokedBeforeDecision) expect(await maximumOf(plan.taskId)).toBe(MAXIMUM);
  });

  it('a first approval committed before the second takes task locks counts as the first eye', async () => {
    const plan = await planned(planner);
    let release!: () => void;
    let signal!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstsRead = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const secondDecision = s.db.app.withBusiness(s.business, async (tx) => {
      const intercepted: TenantQuery = {
        businessId: tx.businessId,
        query: async <Row>(
          sql: string,
          parameters?: readonly unknown[],
        ): Promise<readonly Row[]> => {
          const answer = await tx.query<Row>(sql, parameters);
          if (
            sql.includes('from public.operations o') &&
            sql.includes("o.command = 'budget.top_up'")
          ) {
            expect(answer).toHaveLength(0);
            signal();
            await waiting;
          }
          return answer;
        },
      };
      return await applyTopUp(intercepted, {
        taskId: plan.taskId,
        amountMinor: BigInt(LARGE),
        fromMaximumMinor: BigInt(MAXIMUM),
        personId: second.personId,
        subjects: [
          { kind: 'person', id: second.personId },
          { kind: 'actor', id: second.actorId },
        ],
        collection: 'billing',
      });
    });
    await firstsRead;
    const firstConnection = racer(s);
    try {
      const first = await executeCommand(
        firstConnection,
        s.business,
        s.decider.presented,
        'api',
        topUpBody(plan.taskId, LARGE, MAXIMUM) as never,
      );
      expect(appliedDetail(first, 'first top-up')).toMatchObject({
        state: 'awaiting_second_approver',
      });
    } finally {
      release();
      await firstConnection.close();
    }
    const outcome = await secondDecision;
    expect(outcome.ok && outcome.value.state).toBe('applied');
    expect(await maximumOf(plan.taskId)).toBe(MAXIMUM + LARGE);
  });

  it('a late first approver whose grant is being revoked rolls the decision back without waiting', async () => {
    const plan = await planned(planner);
    const late = await enrol(s.db.app, s.business, 'late-first');
    const grantId = await s.db.app.withBusiness(
      s.business,
      async (tx) => await grantTo(tx, late, 'decide', undefined, false, 'billing'),
    );
    let resume!: () => void;
    let paused!: () => void;
    const go = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const atDiscovery = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const decision = s.db.app.withBusiness(s.business, async (tx) => {
      let first = true;
      const intercepted: TenantQuery = {
        businessId: tx.businessId,
        query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
          const answer = await tx.query<Row>(sql, parameters);
          if (first && sql.includes('select distinct')) {
            first = false;
            paused();
            await go;
          }
          return answer;
        },
      };
      return await applyTopUp(intercepted, {
        taskId: plan.taskId,
        amountMinor: BigInt(LARGE),
        fromMaximumMinor: BigInt(MAXIMUM),
        personId: second.personId,
        subjects: [
          { kind: 'person', id: second.personId },
          { kind: 'actor', id: second.actorId },
        ],
        collection: 'billing',
      });
    });
    await atDiscovery;
    // Own connections: the paused decision holds one of the shared pool's.
    const lateConnection = racer(s);
    const first = await executeCommand(
      lateConnection,
      s.business,
      late.presented,
      'api',
      topUpBody(plan.taskId, LARGE, MAXIMUM) as never,
    );
    await lateConnection.close();
    appliedDetail(first, 'late first approval');
    // A revocation holds the late approver's grant row while the decision resumes.
    const revoker = racer(s);
    let unlock!: () => void;
    const held = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    let locked!: () => void;
    const lockedNow = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const revocation = revoker.withBusiness(s.business, async (tx) => {
      await tx.query('select id from public.grants where id = $1 for update', [grantId]);
      locked();
      await held;
    });
    await lockedNow;
    resume();
    await expect(decision).rejects.toThrow(/AffectedSetChanged|being changed/u);
    unlock();
    await revocation;
    await revoker.close();
    expect(await maximumOf(plan.taskId)).toBe(MAXIMUM);
  });
});
