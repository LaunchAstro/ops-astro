// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-07b, one lock order on inbox items: a daily batch and the provider's
// hook both lock the items one email covered, each in its own transaction.
// Both take them in item id order, so a new daily pass that overlaps a
// delayed hook for the previous batch waits on it and never deadlocks, even
// when the items were raised in the reverse of their id order: the pass finds
// nothing left to send and the hook lands its delivery.

import { randomUUID } from 'node:crypto';
import { expect, it as vitestIt } from 'vitest';
import { emailDailyBatch, landEmailEvent } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { itemFor, noDatabase, useEmailWorld, w } from './email-world.ts';
import { aged, freshInbox, timing, useTimingWorld } from './email-timing-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

useEmailWorld();
useTimingWorld();

function signal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** `database`, pausing after the first statement containing `sqlFragment` until `resume`. */
function paused(
  database: Database,
  sqlFragment: string,
  locked: () => void,
  resume: Promise<void>,
): Database {
  let first = true;
  return {
    ...database,
    withBusiness: async (business, run) =>
      await database.withBusiness(
        business,
        async (tx) =>
          await run({
            ...tx,
            query: async <Row>(
              sql: string,
              params?: readonly unknown[],
            ): Promise<readonly Row[]> => {
              const rows = await tx.query<Row>(sql, params);
              if (first && sql.includes(sqlFragment)) {
                first = false;
                locked();
                await resume;
              }
              return rows;
            },
          }),
      ),
  };
}

/** Two items batched and accepted a day ago, raised in the reverse of their id order. */
async function previousBatch(): Promise<string> {
  const ids = [await itemFor(w.task, 'mention'), await itemFor(w.task, 'assignment')].toSorted();
  const [, high] = ids;
  await w.db.admin.execute(
    `update public.inbox_items set raised_at = now() - case when id = $1 then interval '2 hours'
                                                            else interval '1 hour' end
      where id = any($2::uuid[])`,
    [high, ids],
  );
  expect(await emailDailyBatch(w.db.app, w.alpha, w.person, timing())).toMatchObject({
    ok: true,
    items: 2,
  });
  const message = w.provider.outbox.at(-1)?.id;
  if (message === undefined) throw new Error('missing message');
  await aged('25 hours');
  return message;
}

it('AW-07b one lock order: a new daily pass and a hook for the previous batch do not deadlock', async () => {
  await freshInbox();
  const message = await previousBatch();
  const batchDb = connect(w.db.appUrl);
  const hookDb = connect(w.db.appUrl);
  const resume = signal();
  const batchLocked = signal();
  const hookLocked = signal();
  const batch = emailDailyBatch(
    paused(batchDb, 'for update of i', batchLocked.resolve, resume.promise),
    w.alpha,
    w.person,
    timing(),
  );
  const hook = landEmailEvent(
    paused(hookDb, 'for update', hookLocked.resolve, resume.promise),
    [w.alpha],
    { id: `msg_${randomUUID()}`, messageId: message, type: 'email.delivered' },
  );
  // Rejection handlers attached before either transaction can be chosen as the victim.
  const settled = Promise.allSettled([batch, hook]);
  try {
    // Each holds its first item lock, or one waits on the other's: in one
    // order the second never holds a first lock while the first is paused.
    await Promise.race([
      Promise.all([batchLocked.promise, hookLocked.promise]),
      new Promise<void>((resolve) => {
        setTimeout(resolve, 2000);
      }),
    ]);
  } finally {
    resume.resolve();
    await settled;
    await Promise.all([batchDb.close(), hookDb.close()]);
  }
  const outcomes = (await settled).map((result) =>
    result.status === 'fulfilled'
      ? result.value
      : `rejected ${String((result.reason as { code?: string }).code)}`,
  );
  // The previous batch's items may have gone, so the new pass finds nothing to send, and the
  // hook lands its delivery.
  expect(outcomes).toEqual([{ ok: false, code: 'NOTHING_WAITING' }, 'DELIVERED']);
});
