// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's agent request reads its delegation again after its last lock wait. A
// request made under a pickup's delegation, parked on its task's lock while
// that delegation expires, is refused once it gets through, and no correction
// is stored. A real two-connection race: the request on the app's own
// connection, the task held on another, and the request seen parked on its
// insert in `pg_locks` before the delegation's expiry passes on the database
// clock.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from '../commands/agent-fixture.ts';
import { awaitParked, holdRows, waitPast, type Schedules } from '../runtime/schedules-harness.ts';
import { c80World, requestBody, type C80World } from './c80-world.ts';

const serverUrl = databaseUrlFromEnvironment();
if (serverUrl === undefined)
  console.warn('C80 agent authority after a wait: DATABASE_URL is unset, so nothing ran.');

let w: C80World;
/** The harness's view of the world: its databases and its business. */
let s: Schedules;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await c80World('c80afterwaitagent');
  s = { db: w.world.db, business: w.world.business } as Schedules;
}, 120_000);
afterAll(async () => {
  if (serverUrl !== undefined) await w.world.drop();
});

const EXPIRY = 'select expires_at from public.delegations where id = $1';

/** The delegation the pickup of `taskId` minted. */
async function delegationOf(taskId: string): Promise<string> {
  const [row] = await w.world.db.admin.execute<{ readonly id: string }>(
    `select id from public.delegations
      where business_id = $1 and purpose_scope_kind = 'record' and purpose_scope_id = $2`,
    [w.world.business, taskId],
  );
  if (row === undefined) throw new Error('the pickup minted no delegation');
  return row.id;
}

/** Whether a backend parked on a row lock is running the correction's insert. */
async function parkedOnTheInsert(): Promise<boolean> {
  const found = await w.world.db.admin.execute<{ readonly query: string }>(
    `select a.query from pg_stat_activity a
      where a.datname = current_database() and a.wait_event_type = 'Lock'`,
  );
  return found.some((row) => /^\s*insert into public\.live_corrections/u.test(row.query));
}

const correctionsOn = async (taskId: string): Promise<number> =>
  Number(
    (
      await w.world.db.admin.execute<{ readonly n: string }>(
        `select count(*)::text as n from public.live_corrections
          where business_id = $1 and task_id = $2`,
        [w.world.business, taskId],
      )
    )[0]?.n,
  );

describe.skipIf(serverUrl === undefined)(
  'C80 agent request, delegation after the task wait',
  () => {
    it('refuses an agent request whose delegation expired while it waited on the task', async () => {
      const picked = await w.pickUpUnder(w.ava, 'the about page', w.partyA);
      const delegation = await delegationOf(picked.taskId);
      const holder = await holdRows(s, 'records', [picked.taskId]);
      await w.world.db.admin.execute(
        `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
        where business_id = $1 and id = $2`,
        [w.world.business, delegation],
      );
      const asking = w.world.asAgent(
        { ...requestBody(w.partyA, picked.taskId), operationId: randomUUID() },
        picked.credential,
      );
      let watched: { readonly parkedOn: boolean; readonly liveWhenParked: boolean | undefined };
      try {
        await awaitParked(s, 'records', 1);
        const [live] = await w.world.db.admin.execute<{ readonly live: boolean }>(
          `select (${EXPIRY}) > clock_timestamp() as live`,
          [delegation],
        );
        watched = { parkedOn: await parkedOnTheInsert(), liveWhenParked: live?.live };
        await waitPast(s, EXPIRY, delegation);
      } finally {
        await holder.release();
      }
      expect({
        ...watched,
        code: codeOf(await asking),
        stored: await correctionsOn(picked.taskId),
      }).toStrictEqual({
        parkedOn: true,
        liveWhenParked: true,
        code: 'DELEGATION_NOT_LIVE',
        stored: 0,
      });
    });
  },
);
