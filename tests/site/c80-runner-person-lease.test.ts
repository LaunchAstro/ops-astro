// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's runner under a person's own lease (delegation null): the lease is not
// standing permission. Once the holder's task and run write grants expire, the
// next run is refused before anything is read or sent, as the runtime's
// `personWriteLive` refuses the person's heartbeat. Every provider is a double.

import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c80World, type C80World } from './c80-world.ts';
import { doubles } from './c80-runner-doubles.ts';
import { runLivePublish } from '../../packages/core-commands/src/index.ts';
import {
  readCorrectionForRun,
  recordObservedResult,
} from '../../packages/core-records/src/site/index.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { WHOLE_BUSINESS, grantTo } from '../commands/fixture.ts';
import postgres from 'postgres';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 person lease: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80person');
  await w.setApprover(w.ben.personId);
}, 120_000);

const ok = (result: Awaited<ReturnType<C80World['as']>>, what: string) => {
  expect(codeOf(result), what).toBe('not-a-refusal');
  return result as { recordId: string; revision: number; detail: Record<string, unknown> };
};

/** A task Cal creates, put under party A by the administrator. */
async function taskUnderA() {
  const created = ok(
    await w.as(w.cal, { command: 'task.create', fields: { title: 'About' } }),
    'create',
  );
  const shared = ok(
    await w.as(w.admin, {
      command: 'task.set_party',
      recordId: created.recordId,
      expectedRevision: created.revision,
      fields: { client: w.partyA },
    }),
    'set_party',
  );
  return { taskId: String(created.recordId), revision: Number(shared.revision) };
}

/** Cal's own pickup of a task under party A: a person's lease, no delegation. */
async function personLease() {
  const task = await taskUnderA();
  const proposed = detailOf(
    await w.as(w.cal, {
      command: 'task.propose',
      recordId: task.taskId,
      expectedRevision: task.revision,
      purpose: 'draft_person',
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'draft a reply' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  const decided = detailOf(
    await w.as(w.cal, {
      command: 'task.decide',
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'approved for the holder to work',
    }),
  );
  const picked = detailOf(
    await w.as(w.cal, { command: 'task.pickup', reservationId: decided['reservationId'] }),
  );
  const [lease] = await w.world.db.admin.execute<{
    id: string;
    fence: string;
    holder: string;
    d: string | null;
  }>(
    `select id, fence::text as fence, holder_actor_id as holder, delegation_id as d
       from public.leases where id = $1`,
    [picked['leaseId']],
  );
  if (lease === undefined) throw new Error('no person lease');
  expect(lease.d).toBeNull();
  return {
    taskId: task.taskId,
    leaseId: lease.id,
    fence: Number(lease.fence),
    actorId: lease.holder,
  };
}

/** A revocation on another connection that gives up after 250 ms; true when it committed. */
async function revokeElsewhere(revoker: Database, grantId: string): Promise<boolean> {
  try {
    return await revoker.withBusiness(w.world.business, async (other) => {
      await other.query("set local lock_timeout = '250ms'");
      await revokeGrant(other, grantId);
      return true;
    });
  } catch (error) {
    if (!(error instanceof postgres.PostgresError) || error.code !== '55P03') throw error;
    return false;
  }
}

/** An approved correction on a task Cal holds under a person lease. */
async function approvedUnderPersonLease() {
  const held = await personLease();
  const detail = detailOf(await w.request(w.ava, { taskId: held.taskId }));
  const id = String(detail['correctionId']);
  expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
  return { ...held, id };
}

type Held = Awaited<ReturnType<typeof approvedUnderPersonLease>>;

/** The holder's live publish receipt, with `onQuery` run before each of its statements. */
async function recordLive(held: Held, onQuery: (sql: string) => Promise<void>) {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const scheduled: TenantQuery = {
      businessId: tx.businessId,
      async query<Row>(sql: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
        await onQuery(sql);
        return await tx.query<Row>(sql, parameters);
      },
    };
    const { id, leaseId, fence, actorId } = held;
    const live = { step: 'publish', outcome: 'live', observations: { seen: 'live' } } as const;
    return await recordObservedResult(scheduled, {
      correctionId: id,
      leaseId,
      fence,
      actorId,
      ...live,
    });
  });
}

/** Every task write Cal holds, revoked on the other connection. */
async function revokeOwnTaskWrites(revoker: Database): Promise<void> {
  const old = await w.world.db.admin.execute<{ id: string }>(
    `select id from public.grants where business_id = $1 and subject_id = any($2::uuid[])
        and collection = 'task' and action = 'write' and revoked_at is null`,
    [w.world.business, [w.cal.personId, w.cal.actorId]],
  );
  for (const grant of old) {
    // oxlint-disable-next-line no-await-in-loop -- one connection
    expect(await revokeElsewhere(revoker, grant.id)).toBe(true);
  }
}

describe.skipIf(serverUrl === undefined)(
  'C80 receipt under a person lease, a grant it never held',
  () => {
    it('refuses a receipt carried by a grant issued after its hold and revoked before its write', async () => {
      const held = await approvedUnderPersonLease();
      const revoker = connect(w.world.db.appUrl, { source: 'runtime' });
      let issued: string | undefined;
      let revoked = false;
      try {
        await revokeOwnTaskWrites(revoker);
        const result = await recordLive(held, async (sql) => {
          if (issued === undefined && /for share of l/u.test(sql)) {
            const task = { kind: 'record', id: held.taskId } as const;
            issued = await revoker.withBusiness(w.world.business, (other) =>
              grantTo(other, w.cal, 'write', task),
            );
          }
          if (issued !== undefined && /update public\.live_corrections/u.test(sql))
            revoked = await revokeElsewhere(revoker, issued);
        });
        expect(issued).toBeDefined();
        expect({
          writeOk: result.ok,
          state: await w.stateOf(held.id),
          receipts: await w.receiptsOf(held.id),
        }).toStrictEqual({ writeOk: false, state: 'approved', receipts: 0 });
        expect(revoked).toBe(true);
      } finally {
        // Cal's writes back, for the next case's pickup.
        await w.world.db.app.withBusiness(w.world.business, async (tx) => {
          await grantTo(tx, w.cal, 'write');
          await grantTo(tx, w.cal, 'write', WHOLE_BUSINESS, false, 'run');
        });
        await revoker.close();
      }
    });
  },
);

describe.skipIf(serverUrl === undefined)('C80 runner under a person lease', () => {
  it('refuses the read and the send once the holder’s write grants expired', async () => {
    const held = await personLease();
    const detail = detailOf(await w.request(w.ava, { taskId: held.taskId }));
    const id = String(detail['correctionId']);
    expect(codeOf(await w.approve(w.ben, id, String(detail['versionId'])))).toBe('not-a-refusal');
    const run = { business: w.world.business, correctionId: id, ...held };
    const before = await w.world.db.app.withBusiness(w.world.business, (tx) =>
      readCorrectionForRun(tx, run),
    );
    expect(before.ok).toBe(true);
    const expired = await w.world.db.admin.execute<{ id: string }>(
      `update public.grants set expires_at = clock_timestamp() + interval '1 second'
        where business_id = $1 and subject_id = any($2::uuid[])
          and collection in ('task', 'run') and action = 'write' and revoked_at is null
        returning id`,
      [w.world.business, [w.cal.personId, w.cal.actorId]],
    );
    expect(expired.length).toBeGreaterThan(0);
    await sleep(1_500);
    const ports = doubles();
    expect(await runLivePublish(w.world.db.app, run, ports)).toMatchObject({ kind: 'refused' });
    expect([ports.seen.sourceReads, ports.seen.dispatched.length]).toEqual([0, 0]);
    expect([await w.stateOf(id), await w.receiptsOf(id)]).toEqual(['approved', 0]);
  });
});
