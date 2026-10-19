// SPDX-License-Identifier: AGPL-3.0-only
//
// C35 (#2103, Sol's S2109-1 proof): an agent's open or capture under a `review:write`
// delegation is judged again after the agent entry's last wait, the agent actor's `for share`.
// A delegating person's grant that expires while the call waits there refuses the call, and
// nothing it wrote is kept. A third connection holds the actor; the grant's expiry passes on
// the database clock while the call is seen parked on that statement.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo } from '../commands/fixture.ts';
import { codeOf, detailOf } from '../commands/agent-fixture.ts';
import { barrier, racer, type Schedules } from '../runtime/schedules-harness.ts';
import { ABOUT, PAGE, c35World, type C35World } from './c35-world.ts';
import { delegateReview } from './c35-delegated.ts';

const serverUrl = databaseUrlFromEnvironment();
let w: C35World;
beforeAll(async () => {
  if (serverUrl !== undefined) w = await c35World('c35finalwait');
}, 180_000);
afterAll(async () => {
  await w?.world.drop();
});

/** The agent actor held on a connection of its own until `release` is called. */
async function holdAgentActor() {
  const locker = racer({ db: w.world.db, business: w.world.business } as Schedules);
  const locked = barrier();
  const release = barrier();
  const held = locker.withBusiness(w.world.business, async (tx) => {
    // Allows authentication/revision FK key-share checks, but blocks the final FOR SHARE.
    await tx.query(
      'select id from public.actors where business_id = $1 and id = $2 for no key update',
      [w.world.business, w.world.agentActorId],
    );
    locked.release();
    await release.held;
  });
  await locked.held;
  return {
    async release() {
      release.release();
      await held;
      await locker.close();
    },
  };
}

/** Whether a statement on `public.actors ... for share` is waiting with a blocker. */
async function parkedOnTheActor(): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    // Polling is sequential by definition.
    // eslint-disable-next-line no-await-in-loop
    const rows = await w.world.db.admin.execute<{ parked: boolean }>(
      `select exists (select 1 from pg_stat_activity where datname = current_database()
         and wait_event_type = 'Lock' and query like '%public.actors%'
         and query like '%for share%' and cardinality(pg_blocking_pids(pid)) > 0) as parked`,
    );
    if (rows[0]?.parked === true) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return false;
}

/** With the call parked on the actor: the grant still live, then past its expiry. */
async function expireWhileParked(grantId: string): Promise<void> {
  // A lock upgrade from KEY SHARE may wait on a transaction id without a tuple
  // entry in pg_locks, so observe the actual waiting statement and its blocker.
  expect(await parkedOnTheActor(), 'agent reached its final actor FOR SHARE lock wait').toBe(true);
  const [live] = await w.world.db.admin.execute<{ live: boolean }>(
    'select expires_at > clock_timestamp() as live from public.grants where id = $1',
    [grantId],
  );
  expect(live?.live, 'review write grant still live when the final lock wait is observed').toBe(
    true,
  );
  await w.world.db.admin.execute(
    'select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp()))) from public.grants where id = $1',
    [grantId],
  );
  const [clock] = await w.world.db.admin.execute<{ expired: boolean }>(
    'select expires_at <= clock_timestamp() as expired from public.grants where id = $1',
    [grantId],
  );
  expect(clock?.expired, 'review write grant expired before releasing the final lock').toBe(true);
}

const counts = async () => [
  await w.count('review_revisions', w.world.business),
  await w.count('review_captures', w.world.business),
];

describe.skipIf(serverUrl === undefined)('C35 review:write, after the final wait', () => {
  it.each(['review.open', 'review.capture'] as const)(
    '%s refuses review authority that expires during the final actor lock wait',
    async (command) => {
      const revisionId = detailOf(await w.open(w.ava))['revisionId'];
      const member = await enrol(w.world.db.app, w.world.business, `late-${randomUUID()}`);
      const grantId = await w.world.db.app.withBusiness(
        w.world.business,
        async (tx) =>
          await grantTo(tx, member, 'write', { kind: 'business', id: null }, false, 'review'),
      );
      const delegation = await delegateReview(w, member, w.taskA);
      const actor = await holdAgentActor();
      await w.world.db.admin.execute(
        "update public.grants set expires_at = clock_timestamp() + interval '20 seconds' where id = $1",
        [grantId],
      );
      const before = await counts();
      const body =
        command === 'review.open'
          ? { command, taskId: w.taskA, pageUrl: PAGE, path: ABOUT, sourceRevision: 'sol-late' }
          : { command, revisionId };
      const running = w.world.asAgent(
        { operationId: randomUUID(), ...body },
        delegation.credential,
      );
      try {
        await expireWhileParked(grantId);
      } finally {
        await actor.release();
      }
      const answer = await running;
      expect({ code: codeOf(answer), counts: await counts() }).toStrictEqual({
        code: 'DELEGATION_NARROWED',
        counts: before,
      });
    },
    60_000,
  );
});
