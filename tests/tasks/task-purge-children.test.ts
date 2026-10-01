// SPDX-License-Identifier: AGPL-3.0-only
//
// The purge and a trashed task's time entries and tags (review 2c1 finding 6,
// A1-1). `time_entries` (0078) and `task_tags` (0081) each carry a key to
// `records` that does not cascade, and the purge once neither checked nor
// removed them: one aged trashed task with a time entry or a tag faulted
// the delete and rolled back the business's whole purge, every run. The rows
// are the task's work, so they go with it, like its comments and links.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { purgeTrashedRecords, trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';
import { logTime, startTimer } from '../../packages/core-records/src/tasks/time.ts';
import { addTaskTag, createTag } from '../../packages/core-records/src/tasks/tags.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { createTask } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'task purge children: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

/** How many rows of `table` name one of `taskIds`. */
async function rowsOn(tx: TenantQuery, table: string, taskIds: readonly string[]) {
  const rows = await tx.query<{ readonly n: number }>(
    `select count(*)::int as n from public.${table}
      where business_id = $1 and task_id = any ($2::uuid[])`,
    [tx.businessId, taskIds],
  );
  return rows[0]?.n;
}

/**
 * Three trashed tasks: one with a logged entry and a tag, one with a timer
 * left running, and one with neither.
 */
async function seedTrash(tx: TenantQuery) {
  const spine = await installTaskSpine(tx);
  const personId = await insertPerson(tx, 'a timer');
  const actorId = await insertActor(tx, personId);
  const person = { personId, actorId };
  const timed = await createTask(tx, spine, { title: 'timed and tagged', parentId: null });
  const running = await createTask(tx, spine, { title: 'timer left running', parentId: null });
  const plain = await createTask(tx, spine, { title: 'plain', parentId: null });
  const logged = await logTime(tx, { ...person, taskId: timed, minutes: 30, note: 'n' });
  expect(logged.kind).toBe('logged');
  expect((await startTimer(tx, { ...person, taskId: running })).kind).toBe('started');
  const tag = await createTag(tx, { name: 'Urgent', actorId });
  if (tag.kind !== 'created') throw new Error('tag not created');
  expect(await addTaskTag(tx, { taskId: timed, tagId: tag.tag.id, actorId })).toBe('added');
  const trash = async (rootId: string) => {
    const trashed = await trashSubtree(tx, { rootId, actorId });
    if (isRecordsRefusal(trashed)) throw new Error(trashed.code);
  };
  await trash(timed);
  await trash(running);
  await trash(plain);
  return { taskTypeId: spine.taskTypeId, ids: [timed, running, plain], tagId: tag.tag.id };
}

/** What of `ids` is left: records, time entries, task tags, and the tag vocabulary. */
async function leftOf(tx: TenantQuery, ids: readonly string[]) {
  const records = await tx.query<{ readonly id: string }>(
    `select id from records where business_id = $1 and id = any ($2::uuid[])`,
    [tx.businessId, ids],
  );
  const tags = await tx.query<{ readonly id: string }>(
    `select id from public.tags where business_id = $1`,
    [tx.businessId],
  );
  return {
    rows: [
      records.length,
      await rowsOn(tx, 'time_entries', ids),
      await rowsOn(tx, 'task_tags', ids),
    ],
    vocabulary: tags.map((row) => row.id),
  };
}

let db: FreshDatabase | undefined;
let businessId: string;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'pc' });
  businessId = await insertBusiness(db.app, 'task-purge-children');
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

describe.skipIf(serverUrl === undefined)('the purge and a task’s time and tags', () => {
  it('purge removes an aged trashed task that has a time entry and a tag; the rest of the business purges', async () => {
    if (db === undefined) throw new Error('no database');
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const seeded = await seedTrash(tx);
      const purged = await purgeTrashedRecords(tx, {
        recordTypeId: seeded.taskTypeId,
        trashedBefore: new Date(Date.now() + 1000),
      });
      return { ...seeded, purged, left: await leftOf(tx, seeded.ids) };
    });
    if (isRecordsRefusal(seen.purged)) throw new Error(seen.purged.code);
    expect(seen.purged.recordIds).toStrictEqual(seen.ids.toSorted());
    expect(seen.purged.retainedIds).toStrictEqual([]);
    expect(seen.left.rows).toStrictEqual([0, 0, 0]);
    // The tag stays in the vocabulary; only the task's carrying of it goes.
    expect(seen.left.vocabulary).toStrictEqual([seen.tagId]);
  });
});
