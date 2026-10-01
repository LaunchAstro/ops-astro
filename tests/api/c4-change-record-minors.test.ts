// SPDX-License-Identifier: AGPL-3.0-only
//
// C4's change record holds tasks only, and only while they exist (review 2b1,
// minors 2 and 3): a purged task leaves no row behind, and a record that is not
// a task and names none stamps nothing and is never served as a task.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purgeTrashedRecords } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World, type Party } from '../runtime/cq-8-world.ts';
import { changeKit, ids, tasksOf } from './c4-change-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) console.warn('api/c4-change-record-minors: DATABASE_URL is unset.');
let s: Schedules;
let alpha: Party;
const { since, touch } = changeKit(() => s);

const rowsFor = async (recordId: string): Promise<number> =>
  (
    await s.db.admin.execute<{ id: string }>(
      'select subject_id as id from public.live_changes where subject_id = $1',
      [recordId],
    )
  ).length;

/** C4 change record: purging a task removes its change row */
async function purgedLeavesNoRow(): Promise<void> {
  const [, two] = tasksOf(alpha);
  await touch(alpha.id, [two]);
  expect(await rowsFor(two)).toBe(1);
  const purged = await s.db.app.withBusiness(alpha.id, async (tx) => {
    await tx.query(
      `update public.records
          set deleted_at = now() - interval '1 day', deleted_by_actor_id = $2,
              trash_batch_id = gen_random_uuid()
        where id = $1`,
      [two, alpha.member.actorId],
    );
    const [type] = await tx.query<{ id: string }>(
      `select id from public.record_types where business_id = $1 and key = 'task'`,
      [tx.businessId],
    );
    return await purgeTrashedRecords(tx, {
      recordTypeId: String(type?.id),
      trashedBefore: new Date(),
    });
  });
  expect(purged).toMatchObject({ recordIds: [two] });
  expect(await rowsFor(two)).toBe(0);
}

/** C4 change record: a record that is not a task and names none stamps nothing */
async function nonTaskStampsNothing(): Promise<void> {
  const { point } = await since(alpha.id, alpha.member, null);
  const recordId = randomUUID();
  await s.db.app.withBusiness(alpha.id, async (tx) => {
    const typeId = randomUUID();
    await tx.query(
      `insert into public.record_types (business_id, id, key, name) values ($1, $2, $3, 'Client')`,
      [tx.businessId, typeId, `client_${randomUUID().slice(0, 8)}`],
    );
    await tx.query(
      `insert into public.records (business_id, id, record_type_id) values ($1, $2, $3)`,
      [tx.businessId, recordId, typeId],
    );
    await tx.query('update public.records set data = data where id = $1', [recordId]);
  });
  expect(await rowsFor(recordId)).toBe(0);
  expect(ids(await since(alpha.id, alpha.member, point))).not.toContain(recordId);
}

describe.skipIf(serverUrl === undefined)(
  'C4 the live change record holds live tasks only',
  { timeout: 30_000 },
  () => {
    beforeAll(async () => {
      s = await openSchedules('c4mn', 1_000_000);
      alpha = await cq8World(s).party(`c4m-${randomUUID().slice(0, 8)}`);
    }, 180_000);

    afterAll(async () => {
      await s?.db.drop();
    });
    it('C4 change record: purging a task removes its change row', purgedLeavesNoRow);
    it(
      'C4 change record: a record that is not a task and names none stamps nothing',
      nonTaskStampsNothing,
    );
  },
);
