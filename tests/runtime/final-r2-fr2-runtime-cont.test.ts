// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2 at 3eb0cc1, lane FR2-RUNTIME continuation: the rest of
// R2-RUNTIME-4. Each site read the claimant's grants through `now()`, the
// transaction's start, after it had waited on its locks, so a grant that
// expired during the wait still counted. Every case parks the call on a lock
// held by a third connection, lets the grant lapse, then releases it. Each
// was red at the merged head ef02a40 before its fix (PROVE-BEFORE-FIX).
//
// - a person's pickup parked on the cap;
// - an agent's pickup parked on the cap, whose delegation is minted against
//   the approving person's grants (`mintDelegation`);
// - a person's heartbeat parked on its lease;
// - a person's handback parked on its lease.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  authorised,
  createBusinessResolver,
  post,
  SECRET,
  tokenFor,
  type Answer,
} from '../api/fixture.ts';
import {
  agentPath,
  createControls,
  detailOf,
  personPath,
  type Controls,
} from '../api/controls-fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's connection to the controls database, which holds rows open and watches waiters. */
function ownerOf(c: Controls): postgres.Sql {
  const url = new URL(serverUrl as string);
  url.pathname = `/${c.fixture.db.name}`;
  return postgres(url.toString(), { max: 2, onnotice: () => undefined });
}

/** A second API on its own pool, so a second request queues on a row lock and not in the pool. */
interface Second {
  asPerson(name: string, body: Readonly<Record<string, unknown>>, as: Member): Promise<Answer>;
  asAgent(name: string, body: Readonly<Record<string, unknown>>): Promise<Answer>;
  close(): Promise<void>;
}

function secondOf(c: Controls): Second {
  const database: Database = connect(c.fixture.db.appUrl, { source: 'runtime' });
  const api: Hono = createApi({
    database,
    verify: createSupabaseVerifier({ secret: SECRET }),
    resolveBusiness: createBusinessResolver(c.fixture.db.admin),
    executeCommand,
    executeRead,
    executeAgentCommand,
  });
  return {
    asPerson: async (name, body, as) =>
      await post(
        api,
        personPath(name),
        { operationId: randomUUID(), ...body },
        authorised(await tokenFor(as.presented.subject)),
      ),
    asAgent: async (name, body) =>
      await post(
        api,
        agentPath(name),
        { operationId: randomUUID(), ...body },
        authorised(await tokenFor(c.fixture.agent.subject)),
      ),
    close: async () => {
      await database.close();
    },
  };
}

/** Waits until `count` backends in this database are waiting on a lock. */
async function waitersReach(owner: postgres.Sql, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await owner<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;
    if (Number(rows[0]?.n) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error(`fewer than ${String(count)} backends ever waited on a lock`);
}

const noop = (): void => undefined;

/** A transaction on the owner's connection that holds `statements`' rows until released. */
function hold(
  owner: postgres.Sql,
  statements: (sql: postgres.TransactionSql) => Promise<void>,
): { readonly done: Promise<unknown>; readonly release: () => void } {
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = owner.begin(async (sql) => {
    await statements(sql);
    await released;
  });
  return { done, release };
}

/** Runs `schedule` while `blocker` is open, and always releases it. */
async function whileHeld<T>(
  blocker: { readonly done: Promise<unknown>; readonly release: () => void },
  schedule: () => Promise<T>,
): Promise<T> {
  try {
    return await schedule();
  } finally {
    blocker.release();
    await blocker.done;
  }
}

/** Sets `grantId` to expire two seconds from the database's now. */
async function expireSoon(c: Controls, grantId: string): Promise<void> {
  await c.fixture.db.admin.execute(
    `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
      where id = $1`,
    [grantId],
  );
}

describe.skipIf(serverUrl === undefined)(
  'FR2-RUNTIME-CONT: R2-RUNTIME-4 at every under-lock site',
  () => {
    let c: Controls;
    let owner: postgres.Sql;
    let second: Second;

    beforeAll(async () => {
      c = await createControls('fr2rc');
      owner = ownerOf(c);
      second = secondOf(c);
    }, 120_000);

    afterAll(async () => {
      await owner?.end();
      await second?.close();
      await c?.drop();
    });

    async function capId(): Promise<string> {
      const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
        `select id from public.budget_caps where business_id = $1`,
        [c.fixture.business],
      );
      return String(rows[0]?.id);
    }

    /** A person whose write on tasks is one grant, plus read. */
    async function worker(): Promise<{ readonly member: Member; readonly writeId: string }> {
      const member = await enrol(c.fixture.db.app, c.fixture.business, `worker-${randomUUID()}`);
      let writeId = '';
      await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
        await grantTo(tx, member, 'read');
        writeId = await grantTo(tx, member, 'write');
      });
      return { member, writeId };
    }

    async function approved(title: string): Promise<string> {
      const task = await c.createTask(title);
      return await c.approve(await c.propose(task.id, task.revision));
    }

    /** Runs `request` parked on `blocker` until the grant has lapsed, then releases it. */
    async function parkedPastExpiry(
      blocker: { readonly done: Promise<unknown>; readonly release: () => void },
      request: () => Promise<Answer>,
    ): Promise<Answer> {
      // A tuple, not the promise: an async function returning a promise adopts it.
      const [answer] = await whileHeld(blocker, async () => {
        await sleep(50);
        const sent = request();
        await waitersReach(owner, 1);
        await sleep(2_500);
        return [sent] as const;
      });
      return await answer;
    }

    const leases = async (reservationId: string): Promise<number> =>
      await c.count(`select count(*)::text as n from public.leases where reservation_id = $1`, [
        reservationId,
      ]);

    it('a person pickup parked on the cap: SCOPE_NOT_GRANTED, no lease', async () => {
      const reservationId = await approved('person pickup, grant lapses under the cap');
      const { member, writeId } = await worker();
      await expireSoon(c, writeId);
      const cap = await capId();
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.budget_caps where id = ${cap} for update`;
      });
      const picked = await parkedPastExpiry(
        blocker,
        async () =>
          await second.asPerson('task.pickup', { reservationId, leaseSeconds: 600 }, member),
      );
      expect(picked.body['code'], JSON.stringify(picked.body)).toBe('SCOPE_NOT_GRANTED');
      expect(await leases(reservationId)).toBe(0);
    }, 60_000);

    it('an agent pickup parked on the cap: the approver’s lapsed write mints no delegation', async () => {
      const approver = await enrol(
        c.fixture.db.app,
        c.fixture.business,
        `approver-${randomUUID()}`,
      );
      let writeId = '';
      await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
        await grantTo(tx, approver, 'read');
        await grantTo(tx, approver, 'comment');
        await grantTo(tx, approver, 'decide');
        writeId = await grantTo(tx, approver, 'write');
      });
      const task = await c.createTask('agent pickup, approver grant lapses under the cap');
      const proposal = await c.propose(task.id, task.revision);
      const decided = await c.asPerson(
        'task.decide',
        {
          gateId: proposal['gateId'],
          versionId: proposal['versionId'],
          decision: 'approve',
          note: 'approved by a person whose write is about to lapse',
        },
        approver,
      );
      expect(decided.status, JSON.stringify(decided.body)).toBe(200);
      const reservationId = String(detailOf(decided)['reservationId']);
      await expireSoon(c, writeId);
      const cap = await capId();
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.budget_caps where id = ${cap} for update`;
      });
      const picked = await parkedPastExpiry(
        blocker,
        async () => await second.asAgent('task.pickup', { reservationId, leaseSeconds: 600 }),
      );
      expect(picked.body['code'], JSON.stringify(picked.body)).toBe('DELEGATION_WIDENS');
      expect(await leases(reservationId)).toBe(0);
      expect(
        await c.count(
          `select count(*)::text as n from public.delegations
          where business_id = $1 and delegate_person_id = $2`,
          [c.fixture.business, approver.personId],
        ),
      ).toBe(0);
    }, 60_000);

    /** A live person lease whose holder's write lapses two seconds from now. */
    async function leased(title: string) {
      const reservationId = await approved(title);
      const { member, writeId } = await worker();
      const picked = await c.asPerson('task.pickup', { reservationId, leaseSeconds: 600 }, member);
      expect(picked.status, JSON.stringify(picked.body)).toBe(200);
      const lease = detailOf(picked);
      await expireSoon(c, writeId);
      const leaseId = String(lease['leaseId']);
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.leases where id = ${leaseId} for update`;
      });
      return { member, leaseId, fence: lease['fence'], blocker };
    }

    it('a person heartbeat parked on its lease: SCOPE_NOT_GRANTED, not renewed', async () => {
      const { member, leaseId, fence, blocker } = await leased('heartbeat, grant lapses');
      const before = await c.fixture.db.admin.execute<{ readonly expires_at: unknown }>(
        `select expires_at from public.leases where id = $1`,
        [leaseId],
      );
      const beat = await parkedPastExpiry(
        blocker,
        async () =>
          await second.asPerson('task.heartbeat', { leaseId, fence, leaseSeconds: 1_200 }, member),
      );
      expect(beat.body['code'], JSON.stringify(beat.body)).toBe('SCOPE_NOT_GRANTED');
      expect(
        await c.fixture.db.admin.execute(`select expires_at from public.leases where id = $1`, [
          leaseId,
        ]),
      ).toEqual(before);
    }, 60_000);

    it('a person handback parked on its lease: SCOPE_NOT_GRANTED, the lease stays live', async () => {
      const { member, leaseId, fence, blocker } = await leased('handback, grant lapses');
      const settled = await parkedPastExpiry(
        blocker,
        async () =>
          await second.asPerson('task.handback', { leaseId, fence, outcome: 'completed' }, member),
      );
      expect(settled.body['code'], JSON.stringify(settled.body)).toBe('SCOPE_NOT_GRANTED');
      expect(
        await c.fixture.db.admin.execute<{ readonly state: string }>(
          `select state from public.leases where id = $1`,
          [leaseId],
        ),
      ).toEqual([{ state: 'live' }]);
    }, 60_000);
  },
);
