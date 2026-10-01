// SPDX-License-Identifier: AGPL-3.0-only
//
// The purge and a trashed task's time entries and tags (review 2c1 finding 6,
// A1-1). `time_entries` (0078) and `task_tags` (0081) each carry a key to
// `records` that does not cascade, and the purge once neither checked nor
// removed them: one aged trashed task with a time entry or a tag faulted
// the delete and rolled back the business's whole purge, every run. A task's
// tags go with it, like its comments and links. Its time entries stay
// (ORCH58): they keep their own retention (CS-16.12) and feed billing, so the
// purge detaches them, and a timer left running is stopped first, so its
// person can start another.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { purgeTrashedRecords, trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';
import { logTime, readTaskTime, startTimer } from '../../packages/core-records/src/tasks/time.ts';
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
  const ids = [timed, running, plain];
  const entries = await entriesOf(tx, personId);
  return { spine, person, taskTypeId: spine.taskTypeId, ids, tagId: tag.tag.id, entries };
}

interface EntryRow {
  readonly id: string;
  readonly task_id: string | null;
  readonly ended_at: Date | null;
  readonly minutes: number | null;
}

/** A person's time entries, every column, oldest first. */
function entriesOf(tx: TenantQuery, personId: string) {
  return tx.query<EntryRow & Record<string, unknown>>(
    `select * from public.time_entries where business_id = $1 and person_id = $2
      order by started_at, id`,
    [tx.businessId, personId],
  );
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
  it('purge removes an aged trashed task and its tag but keeps its time entries, detached and otherwise unchanged', async () => {
    if (db === undefined) throw new Error('no database');
    const seen = await db.app.withBusiness(businessId, async (tx) => {
      const seeded = await seedTrash(tx);
      const purged = await purgeTrashedRecords(tx, {
        recordTypeId: seeded.taskTypeId,
        trashedBefore: new Date(Date.now() + 1000),
      });
      const after = await entriesOf(tx, seeded.person.personId);
      // The running timer was stopped, so its person starts another, and the
      // detached minutes show under no other task.
      const next = await createTask(tx, seeded.spine, { title: 'next', parentId: null });
      const started = await startTimer(tx, { ...seeded.person, taskId: next });
      const nextTime = await readTaskTime(tx, next, seeded.person.personId);
      return { ...seeded, purged, after, started, nextTime, left: await leftOf(tx, seeded.ids) };
    });
    if (isRecordsRefusal(seen.purged)) throw new Error(seen.purged.code);
    expect(seen.purged.recordIds).toStrictEqual(seen.ids.toSorted());
    expect(seen.purged.retainedIds).toStrictEqual([]);
    // No record, no tag link, and no entry still naming a purged task.
    expect(seen.left.rows).toStrictEqual([0, 0, 0]);
    // The tag stays in the vocabulary; only the task's carrying of it goes.
    expect(seen.left.vocabulary).toStrictEqual([seen.tagId]);
    // Both entries survive the purge (not deleted), with no task.
    expect(seen.after.map((row) => row.id)).toStrictEqual(seen.entries.map((row) => row.id));
    expect(seen.after.map((row) => row.task_id)).toStrictEqual([null, null]);
    const [loggedBefore, runningBefore] = seen.entries;
    const [loggedAfter, runningAfter] = seen.after;
    // The logged entry: every field but the task link unchanged.
    expect({ ...loggedAfter, task_id: loggedBefore?.task_id }).toStrictEqual(loggedBefore);
    // The running one: stopped with its elapsed minutes, the rest unchanged.
    expect(runningBefore?.ended_at).toBeNull();
    expect(runningAfter?.ended_at).toBeInstanceOf(Date);
    expect(runningAfter?.minutes).toBe(1);
    expect({
      ...runningAfter,
      task_id: runningBefore?.task_id,
      ended_at: null,
      minutes: null,
    }).toStrictEqual(runningBefore);
    expect(seen.started.kind).toBe('started');
    expect(seen.nextTime.totalMinutes).toBe(0);
    expect(seen.nextTime.entries).toHaveLength(1);
  });
});
