// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.reset_factor`'s handler takes the business's access lock exclusive,
// so the shared preparation before it takes the lock in that mode too: two
// resets at once in one business wait for each other and never deadlock.
//
// Two managers each reset another person's factor, on connections of their
// own. Each is held at its first exclusive request for the access lock until
// both have reached it, then both go on. The database's deadlock count is
// read once their backends have exited: the envelope retries a deadlock
// once, so the answers alone would hide one.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS } from '../commands/fixture.ts';
import { harness, useEndAccessWorld } from './c58-end-access-world.ts';
import { withFactor } from './c59-factor-reset-world.ts';

useEndAccessWorld();
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

const noop = (): void => undefined;

function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = noop;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const deadlocks = async (): Promise<number> => {
  const rows = await harness.world.db.admin.execute<{ readonly n: string }>(
    'select deadlocks::text as n from pg_stat_database where datname = current_database()',
  );
  return Number(rows[0]?.n);
};

/** The count once it moves past `before`, or after a few seconds. */
async function deadlocksAfter(before: number): Promise<number> {
  const until = Date.now() + 3000;
  let now = await deadlocks();
  while (now === before && Date.now() < until) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(50);
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    now = await deadlocks();
  }
  return now;
}

/** A connection of its own, held once at its first exclusive access-lock request. */
function heldAtTheLock(pool: Database, reached: () => void, go: Promise<void>): Database {
  let held = false;
  const key = `access:${harness.world.alpha}`;
  return {
    log: pool.log,
    close: async () => await pool.close(),
    withBusiness: async (businessId, run) =>
      await pool.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters = []) => {
              if (!held && sql.includes('pg_advisory_xact_lock(') && parameters[0] === key) {
                held = true;
                reached();
                await go;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
}

/** A manager of factors and a person with one, in alpha. */
async function managerAndTarget(name: string) {
  const { db, alpha } = harness.world;
  const caller = await enrol(db.app, alpha, `${name}-caller`);
  const target = await enrol(db.app, alpha, `${name}-target`);
  await withFactor(target);
  await db.app.withBusiness(
    alpha,
    async (tx) => await grantTo(tx, caller, 'manage', WHOLE_BUSINESS, false, 'settings'),
  );
  return { caller, target };
}

it('two factor resets at once in one business both apply without a deadlock', async () => {
  const { db, alpha } = harness.world;
  const pairs = [await managerAndTarget('reset-one'), await managerAndTarget('reset-two')];
  const before = await deadlocks();
  const go = latch();
  const reached = pairs.map(() => latch());
  const pools = pairs.map((_, n) =>
    heldAtTheLock(connect(db.appUrl, { max: 1 }), reached[n]?.open ?? noop, go.promise),
  );
  let answers: readonly unknown[];
  try {
    const pending = pairs.map(
      async ({ caller, target }, n) =>
        await executeCommand(pools[n] as Database, alpha, caller.presented, 'api', {
          command: 'access.reset_factor',
          operationId: randomUUID(),
          holderId: target.personId,
        }),
    );
    await Promise.all(reached.map(async (one) => await one.promise));
    go.open();
    answers = await Promise.all(pending);
  } finally {
    go.open();
    // Closed before the count is read: a backend flushes its counts as it exits.
    await Promise.all(pools.map(async (pool) => await pool.close()));
  }
  expect((await deadlocksAfter(before)) - before, 'deadlocks the two resets added').toBe(0);
  for (const answer of answers) {
    expect(isCommandRefusal(answer as object), JSON.stringify(answer)).toBe(false);
  }
});
