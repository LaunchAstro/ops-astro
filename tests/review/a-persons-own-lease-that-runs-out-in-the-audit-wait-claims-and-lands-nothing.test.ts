// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2121, Sol S2121-4): a person's claim or land under their own lease judges that lease
// again after the envelope's last wait. Held on the business's audit chain after the capture
// update until the lease has run out, the claim takes no width and the land keeps no picture.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advisoryLock,
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { c35World, underReview, type C35World, type Reviewed } from './c35-world.ts';
import { capturesOf, observationOf, pictureBytes, storedObjects } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();

let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35personwait');
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

interface PersonLease {
  readonly leaseId: string;
  readonly fence: number;
}

const pause = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
};

/** ava approves work on the task and picks it up herself. */
async function pickedUpByAva(reviewed: Reviewed): Promise<PersonLease> {
  const [task] = await w.world.db.admin.execute<{ revision: string }>(
    'select revision::text from records where id = $1',
    [reviewed.taskId],
  );
  const proposal = detailOf(
    await w.as(w.ava, {
      command: 'task.propose',
      recordId: reviewed.taskId,
      expectedRevision: Number(task!.revision),
      purpose: `person_wait_${randomUUID().slice(0, 8)}`,
      maximumMinor: 3_000,
      currency: 'AUD',
      payload: { instruction: 'capture' },
      step: { kind: 'compose', payload: {} },
    }),
  );
  const decided = detailOf(
    await w.as(w.ava, {
      command: 'task.decide',
      gateId: proposal['gateId'],
      versionId: proposal['versionId'],
      decision: 'approve',
      note: 'ava captures the page herself',
    }),
  );
  const picked = detailOf(
    await w.as(w.ava, { command: 'task.pickup', reservationId: decided['reservationId'] }),
  );
  return { leaseId: String(picked['leaseId']), fence: Number(picked['fence']) };
}

/** Until a statement waits on `blocker` and the lease has run out. */
async function waitedPastExpiry(blocker: () => number | undefined, lease: PersonLease) {
  for (let i = 0; i < 500; i += 1) {
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    const [row] = await w.world.db.admin.execute<{ waiting: boolean; expired: boolean }>(
      `select exists(select 1 from pg_stat_activity
               where datname = current_database() and $1::int = any(pg_blocking_pids(pid))) as waiting,
              (select expires_at <= clock_timestamp() from public.leases where id = $2) as expired`,
      [blocker() ?? 0, lease.leaseId],
    );
    if (row?.waiting === true && row.expired) return true;
    // oxlint-disable-next-line no-await-in-loop -- one probe at a time, each read after the last
    await pause(20);
  }
  return false;
}

/**
 * `body` as ava, under her lease cut to four seconds. Once the handler's capture update has run,
 * a connection of its own takes the business's audit chain and holds it until the call waits
 * there past the expiry.
 */
// eslint-disable-next-line max-lines-per-function -- the hold and the call it holds, together
async function heldOnTheAuditChain(
  lease: PersonLease,
  body: Readonly<Record<string, unknown>>,
): Promise<CommandResult> {
  const holder = connect(w.world.db.appUrl);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocker: number | undefined;
  let held: Promise<void> | undefined;
  const holding = (tx: TransactionQuery): TransactionQuery => ({
    businessId: tx.businessId,
    async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
      const rows = await tx.query<Row>(text, parameters);
      if (held === undefined && text.includes('update public.review_captures')) {
        let locked!: () => void;
        const ready = new Promise<void>((resolve) => {
          locked = resolve;
        });
        held = holder.withBusiness(tx.businessId, async (htx) => {
          await advisoryLock(htx, tx.businessId.toLowerCase());
          const [me] = await htx.query<{ pid: number }>('select pg_backend_pid() as pid');
          blocker = me!.pid;
          locked();
          await gate;
        });
        await ready;
      }
      return rows;
    },
    savepoint: async (work) =>
      await tx.savepoint(async (inner) => {
        await work(holding(inner));
      }),
  });
  const database: Database = {
    log: w.world.db.app.log,
    close: async () => {},
    withBusiness: async (business, run, options) =>
      await w.world.db.app.withBusiness(business, async (tx) => await run(holding(tx)), options),
  };
  await w.world.db.admin.execute(
    "update public.leases set expires_at = clock_timestamp() + interval '4 seconds' where id = $1",
    [lease.leaseId],
  );
  const pending = executeCommand(database, w.world.business, w.ava.presented, 'api', {
    operationId: randomUUID(),
    leaseId: lease.leaseId,
    fence: lease.fence,
    ...body,
  } as never);
  try {
    const waited = await waitedPastExpiry(() => blocker, lease);
    expect(waited, 'the call waited on the audit chain until its lease ran out').toBe(true);
  } finally {
    release();
    await held;
    await holder.close();
    await pending.catch(() => null);
  }
  return await pending;
}

describe.skipIf(serverUrl === undefined)('C35 a person’s call after the audit wait', () => {
  it('a claim whose own lease runs out in the audit wait takes no width', async () => {
    const reviewed = await underReview(w, 'Person claim held past its lease');
    const lease = await pickedUpByAva(reviewed);
    const before = await capturesOf(w, reviewed.revisionId);
    const answer = await heldOnTheAuditChain(lease, {
      command: 'review.capture_claim',
      revisionId: reviewed.revisionId,
    });
    expect({
      code: codeOf(answer),
      captures: await capturesOf(w, reviewed.revisionId),
    }).toStrictEqual({ code: 'LEASE_EXPIRED', captures: before });
  }, 60_000);

  it('a land whose own lease runs out in the audit wait stores nothing', async () => {
    const reviewed = await underReview(w, 'Person land held past its lease');
    const lease = await pickedUpByAva(reviewed);
    expect(
      codeOf(
        await w.as(w.ava, {
          command: 'review.capture_claim',
          leaseId: lease.leaseId,
          fence: lease.fence,
          revisionId: reviewed.revisionId,
        }),
      ),
    ).toBe('not-a-refusal');
    const before = {
      captures: await capturesOf(w, reviewed.revisionId),
      stored: await storedObjects(w, w.world.business),
    };
    const answer = await heldOnTheAuditChain(lease, {
      command: 'review.capture_land',
      revisionId: reviewed.revisionId,
      width: 1480,
      picture: pictureBytes(6).toString('base64'),
      observation: observationOf(1480),
    });
    expect({
      code: codeOf(answer),
      captures: await capturesOf(w, reviewed.revisionId),
      stored: await storedObjects(w, w.world.business),
    }).toStrictEqual({ code: 'LEASE_EXPIRED', ...before });
  }, 60_000);
});
