// SPDX-License-Identifier: AGPL-3.0-only
//
// F2 (DB-PROOF-GAPS-B): a `task.cancel` that discovered an unleased hold and
// then meets a concurrent pickup's committed lease under its locks.
//
// The cancellation rolls back rather than extend its lock set
// (`recovery.ts`, `cancelAndClassify`). Before, the rollback was a plain
// `Error` the person entry did not retry, so the caller got a 503 although the
// same body, sent again, cancelled correctly. Now it is `AffectedSetChanged`,
// and the person entry retries it once in a fresh transaction, as it does for
// a lost identity claim: the first request answers with a typed outcome.
//
// The schedule is W04's (`l6-schedules.test.ts`): a third connection holds the
// cap row, the pickup is seen parked on it, the cancel is seen waiting behind
// it, then the holder lets go. The cancel's connection counts its
// transactions, so the test knows the rediscovery was reached, not dodged.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import { isRetryableViolation } from '../../packages/core-records/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { AffectedSetChanged } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve,
  asAgent,
  asPerson,
  awaitParked,
  codeOf,
  createTask,
  freshPurpose,
  holdRows,
  openSchedules,
  propose,
  racer,
  reasonOf,
  rows,
  scalar,
  settle,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/cancel-rediscover: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** A connection that counts the transactions the command entry opens on it. */
function counted(database: Database): { database: Database; transactions: () => number } {
  let opened = 0;
  const wrapped = new Proxy(database, {
    get(target, property, receiver) {
      if (property === 'withBusiness') {
        return async (...parameters: Parameters<Database['withBusiness']>) => {
          opened += 1;
          return await target.withBusiness(...parameters);
        };
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  return { database: wrapped, transactions: () => opened };
}

describe('the discovery-changed rollback is one typed, retryable error', () => {
  it('is recognised by the person entry, and a plain Error with its message is not', () => {
    const typed = new AffectedSetChanged(
      'cancellation: the affected set changed under discovery; roll back and rediscover rather than extending the lock set',
    );
    expect(typed).toBeInstanceOf(Error);
    expect(typed.message).toMatch(/affected set changed under discovery/u);
    expect(isRetryableViolation(typed)).toBe(true);
    expect(isRetryableViolation(new Error(typed.message))).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('task.cancel meeting a concurrent pickup', () => {
  let s: Schedules;
  let manager: Member;

  beforeAll(async () => {
    s = await openSchedules('cancel_redisc', 1_000_000);
    manager = await enrol(s.db.app, s.business, 'manager');
    await s.db.app.withBusiness(s.business, async (tx) => {
      for (const action of ['read', 'write', 'manage'] as const) {
        // eslint-disable-next-line no-await-in-loop
        await grantTo(tx, manager, action);
      }
    });
  }, 90_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const count = async (text: string, parameters: readonly unknown[]): Promise<number> =>
    await scalar(s, text, [s.business, ...parameters]);

  /** Backends in this database waiting on any lock: the cancel, seen parked. */
  async function awaitWaiting(want: number): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const waiting = await scalar(
        s,
        `select count(*)::text as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
        [],
      );
      if (waiting >= want) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
    throw new Error(`fewer than ${String(want)} backends ever waited: no schedule was established`);
  }

  it('answers the first request with an applied cancel that classifies the hold once', async () => {
    const taskId = await createTask(s, 'a pickup that reaches its lease before the cancel');
    const proposal: Detail = await propose(s, taskId, {
      maximumMinor: 2_000,
      purpose: freshPurpose(),
    });
    const reservationId = String((await approve(s, proposal))['reservationId']);
    const pickupBody = (): Body => ({
      command: 'task.pickup',
      operationId: randomUUID(),
      reservationId,
      leaseSeconds: 600,
    });
    const cancel: Body = {
      command: 'task.cancel',
      operationId: randomUUID(),
      recordId: taskId,
      lineageId: proposal['lineageId'],
      reason: 'the client withdrew the request',
    };

    const pickupDb = racer(s);
    const cancelDb = counted(racer(s));
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    let settled: readonly PromiseSettledResult<CommandResult>[] = [];
    try {
      const picked = asAgent(s, pickupBody(), undefined, pickupDb);
      await awaitParked(s, 'budget_caps', 1);
      const cancelled = asPerson(s, cancel, cancelDb.database);
      await awaitWaiting(2);
      await holder.release();
      settled = await settle([picked, cancelled]);
    } finally {
      await holder.release().catch(() => null);
      await pickupDb.close();
      await cancelDb.database.close();
    }

    for (const each of settled) expect(each.status, reasonOf(each)).toBe('fulfilled');
    const [picked, cancelled] = settled as PromiseFulfilledResult<CommandResult>[];
    expect(codeOf(picked!.value)).toBe('applied');
    // The first request's answer, not a caller's retry: applied.
    expect(codeOf(cancelled!.value)).toBe('applied');
    // Two transactions on the cancel's connection: the one that met the lease
    // and rolled back, and the fresh one that rediscovered and cancelled it.
    expect(cancelDb.transactions()).toBe(2);

    const holds = await rows<{ id: string; state: string; cause: string | null }>(
      s,
      `select id, state, classified_cause as cause from public.reservations
        where business_id = $1 and version_id = $2 order by created_at, id`,
      [s.business, proposal['versionId']],
    );
    // Rows come back without a plain prototype, so compare values.
    expect(holds).toEqual([{ id: reservationId, state: 'abandoned', cause: 'lineage_cancelled' }]);
    expect(
      await count(
        `select count(*)::text as n from public.leases
          where business_id = $1 and task_id = $2 and state = 'live'`,
        [taskId],
      ),
    ).toBe(0);
    // The envelope's held total is the sum of the holds still held: zero.
    expect(
      await count(
        `select (e.held_minor - coalesce((select sum(r.held_minor) from public.reservations r
                  where r.business_id = e.business_id and r.envelope_id = e.id
                    and r.state = 'held'), 0))::text as n
           from public.task_envelopes e where e.business_id = $1 and e.task_id = $2`,
        [taskId],
      ),
    ).toBe(0);
    // One applied audit event for the cancel's operation and no failed one:
    // the rolled-back first transaction is not reported as an attempt.
    const events = await rows<{ outcome: string }>(
      s,
      `select outcome from public.audit_events
        where business_id = $1 and operation_id = $2 order by outcome`,
      [s.business, cancel['operationId']],
    );
    expect(events.map((each) => each.outcome)).toStrictEqual(['applied']);

    // Not revived afterwards.
    expect(codeOf(await asAgent(s, pickupBody()))).toBe('RESERVATION_NOT_CLAIMABLE');
  }, 60_000);

  it('grant.revoke meeting a pickup under the revoked grant answers the first request', async () => {
    const taskId = await createTask(s, 'a pickup racing the revocation of its authority');
    const proposal: Detail = await propose(s, taskId, {
      maximumMinor: 2_000,
      purpose: freshPurpose(),
    });
    const reservationId = String((await approve(s, proposal))['reservationId']);
    const grants = await rows<{ id: string }>(
      s,
      `select id from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and collection = 'task' and action = 'write' and revoked_at is null`,
      [s.business, s.decider.personId],
    );
    expect(grants).toHaveLength(1);
    const revoke: Body = {
      command: 'grant.revoke',
      operationId: randomUUID(),
      grantId: grants[0]?.id,
    };

    const pickupDb = racer(s);
    const revokeDb = counted(racer(s));
    const holder = await holdRows(s, 'budget_caps', [s.capId]);
    let settled: readonly PromiseSettledResult<CommandResult>[] = [];
    try {
      const picked = asAgent(
        s,
        { command: 'task.pickup', operationId: randomUUID(), reservationId, leaseSeconds: 600 },
        undefined,
        pickupDb,
      );
      await awaitParked(s, 'budget_caps', 1);
      const revoked = executeCommand(
        revokeDb.database,
        s.business,
        manager.presented,
        'api',
        revoke as never,
      );
      // The revocation either waits on a lock behind the pickup or commits
      // straight past it; both are schedules this case accepts.
      await Promise.race([awaitWaiting(2), revoked.catch(() => null)]);
      await holder.release();
      settled = await settle([picked, revoked]);
    } finally {
      await holder.release().catch(() => null);
      await pickupDb.close();
      await revokeDb.database.close();
    }

    const [picked, revoked] = settled;
    // The revocation answers the first request with a typed outcome.
    expect(revoked?.status, reasonOf(revoked!)).toBe('fulfilled');
    expect(codeOf((revoked as PromiseFulfilledResult<CommandResult>).value)).toBe('applied');
    // At most one retry, and it is recorded here for the handback: 1 means the
    // grant row's lock serialised the pickup ahead of the revocation's
    // discovery, 2 means the authority-loss rollback was met and retried.
    const transactions = revokeDb.transactions();
    expect([1, 2]).toContain(transactions);
    console.info(`runtime/cancel-rediscover: grant.revoke transactions = ${String(transactions)}`);

    // Whichever order was served, nothing live draws on the revoked grant.
    expect(
      await count(
        `select count(*)::text as n from public.leases l
           join public.delegations d on d.business_id = l.business_id and d.id = l.delegation_id
          where l.business_id = $1 and l.task_id = $2 and l.state = 'live'
            and d.revoked_at is null and d.settled_at is null`,
        [taskId],
      ),
      picked?.status === 'fulfilled' ? codeOf(picked.value) : reasonOf(picked!),
    ).toBe(0);
    const holds = await rows<{ state: string }>(
      s,
      `select state from public.reservations where business_id = $1 and version_id = $2`,
      [s.business, proposal['versionId']],
    );
    expect(holds.filter((hold) => hold.state === 'held').length).toBeLessThanOrEqual(1);
  }, 60_000);
});
