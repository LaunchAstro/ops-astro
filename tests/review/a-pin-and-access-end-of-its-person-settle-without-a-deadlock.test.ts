// SPDX-License-Identifier: AGPL-3.0-only
//
// #2402: `access.end` takes the access lock, then the person's grants, then the tasks their
// live work holds a reservation on. A person's pin takes the access lock shared at the door,
// so the two serialise there. An agent's pin inside the person's delegation takes no access
// lock: it locked its task first and share-locked the delegating person's covering grants
// after, so it and `access.end` of that person, crossing at the task lock, closed a cycle
// that Postgres broke by aborting one (40P01). The pin now holds its covering grants before
// its task, the order `access.end` takes them. The command entry retries a 40P01 once, so
// each side's statements are watched for one; an answer alone would hide it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connect,
  type Database,
  type TransactionQuery,
} from '../../packages/core-records/src/index.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeAgentCommand } from '../../packages/core-commands/src/commands/agent-envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { latch } from '../support/lock-wait-race.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { grantTo } from '../commands/fixture.ts';
import {
  c35World,
  pickUpReviewed,
  spot,
  underReview,
  type C35World,
  type Reviewed,
} from './c35-world.ts';
import { agentLogin, landUnder, pictureBytes, underLease } from './c35-landing.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined) console.warn('#2402 pin and access.end: DATABASE_URL is unset.');

let w: C35World;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c35World('pinaccessend');
  await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    await grantTo(tx, w.admin, 'manage', undefined, false, 'access');
  });
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

/** Every 40P01 a watched statement met, named for its side. */
const deadlocks: string[] = [];

/**
 * An app database of `side`'s own, each statement watched for a 40P01; the pin's pauses once
 * just after it has locked `taskId`.
 */
function watched(side: string, taskId?: string) {
  const db = connect(w.world.db.appUrl);
  const reached = latch();
  const resume = latch();
  let pid = 0;
  const database: Database = {
    log: db.log,
    close: () => db.close(),
    withBusiness: (businessId, run) =>
      db.withBusiness(businessId, async (tx) => {
        const [backend] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
        pid = backend?.pid ?? 0;
        const wrapped: TransactionQuery = {
          businessId: tx.businessId,
          savepoint: (work) => tx.savepoint(work),
          query: async <Row>(sql: string, parameters?: readonly unknown[]) => {
            let rows: readonly Row[];
            try {
              rows = await tx.query<Row>(sql, parameters);
            } catch (error) {
              if ((error as { code?: string }).code === '40P01') deadlocks.push(side);
              throw error;
            }
            if (
              taskId !== undefined &&
              sql.includes('revision::text as revision') &&
              sql.includes('for update') &&
              parameters?.includes(taskId)
            ) {
              reached.open();
              await resume.promise;
            }
            return rows;
          },
        };
        return await run(wrapped);
      }),
  };
  return { database, reached, resume, pid: () => pid };
}

/** True once some backend waits on `pid`'s locks. */
async function blockedBy(pid: number): Promise<boolean> {
  const [row] = await w.world.db.admin.execute<{ readonly blocked: boolean }>(
    `select exists(select 1 from pg_stat_activity where datname = current_database()
        and wait_event_type = 'Lock' and $1::int = any(pg_blocking_pids(pid))) as blocked`,
    [pid],
  );
  return row?.blocked === true;
}

/**
 * A task under review with its 1480 capture landed under the agent's lease: ava's approval
 * reserved the task, so it is her live work, which access.end locks.
 */
async function pinnableAndReserved(): Promise<Reviewed> {
  const reviewed = await underReview(w, 'pin and access.end');
  const lease = await pickUpReviewed(w, reviewed);
  const claim = await underLease(w, lease, {
    command: 'review.capture_claim',
    revisionId: reviewed.revisionId,
  });
  expect(codeOf(claim.result)).toBe('not-a-refusal');
  const landed = await landUnder(w, lease, {
    revisionId: reviewed.revisionId,
    width: 1480,
    picture: pictureBytes(31),
  });
  expect(codeOf(landed.result)).toBe('not-a-refusal');
  return reviewed;
}

/** ava's delegation to the fixture's agent: `review:comment` on `taskId` alone. */
async function commentOn(taskId: string): Promise<string> {
  return await w.world.db.app.withBusiness(w.world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: w.world.agentActorId,
      delegatePersonId: w.ava.personId,
      mintedByActorId: w.ava.actorId,
      purpose: `pin_end_${randomUUID().slice(0, 8)}`,
      collections: ['review'],
      actions: ['comment'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!minted.ok) throw new Error(`mintDelegation refused ${minted.refusal.code}`);
    return minted.value.credential;
  });
}

const pinBody = (revisionId: string) => ({
  command: 'review.pin_comment',
  operationId: randomUUID(),
  revisionId,
  width: 1480,
  selector: [spot()],
  body: 'Move this heading above the fold',
  audience: 'internal',
});

const answer = (sent: Promise<CommandResult>): Promise<string> =>
  sent.then(codeOf, (error: { code?: string }) => `threw ${error.code ?? 'error'}`);

/**
 * `pin` on a backend of its own, paused just after it locks the task; then access.end of ava
 * on another, until it waits on the pin; then the pin let go. Both answers and every 40P01.
 */
async function raced(
  taskId: string,
  pin: (database: Database) => Promise<CommandResult>,
): Promise<{ readonly pinned: string; readonly ended: string; readonly deadlocks: string[] }> {
  deadlocks.length = 0;
  const paused = watched('review.pin_comment', taskId);
  const other = watched('access.end');
  const pinning = answer(pin(paused.database));
  let ending: Promise<string> | undefined;
  try {
    await paused.reached.promise;
    ending = answer(
      executeCommand(other.database, w.world.business, w.admin.presented, 'api', {
        command: 'access.end',
        operationId: randomUUID(),
        holderId: w.ava.personId,
      } as never),
    );
    // access.end waits on the paused pin, wherever its order puts that wait.
    await expect.poll(async () => await blockedBy(paused.pid()), { timeout: 10_000 }).toBe(true);
    paused.resume.open();
    const [pinned, ended] = await Promise.all([pinning, ending]);
    return { pinned, ended, deadlocks: [...deadlocks] };
  } finally {
    paused.resume.open();
    await Promise.allSettled([pinning, ending]);
    await paused.database.close();
    await other.database.close();
  }
}

describe.skipIf(serverUrl === undefined)(
  'a pin and access.end of its person settle without a deadlock',
  () => {
    it("an agent's pin paused at its task lock and access.end of its delegating person settle with no deadlock", async () => {
      const reviewed = await pinnableAndReserved();
      const credential = await commentOn(reviewed.taskId);
      const outcome = await raced(
        reviewed.taskId,
        async (database) =>
          await executeAgentCommand(
            database,
            w.world.business,
            agentLogin(w),
            credential,
            pinBody(reviewed.revisionId) as never,
          ),
      );
      // The pin held ava's grants before her access ended: it lands, and access.end follows it.
      expect(outcome).toStrictEqual({
        pinned: 'not-a-refusal',
        ended: 'not-a-refusal',
        deadlocks: [],
      });
    }, 60_000);
  },
);
