// SPDX-License-Identifier: AGPL-3.0-only
//
// A tag or time write and a trash of the same task at once. The trash holds
// the task's row until it commits; a tag add, a timer start or a logged entry
// that reached the task while the trash was still open must wait for it and
// then answer that the task is gone, never land on the trashed task. The live
// check is a read of the row, so without a row lock it passes on the version
// the trash has not committed yet, and the write goes in after it.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import {
  installTaskSpine,
  type InstalledTaskSpine,
} from '../../packages/core-records/src/tasks/install.ts';
import { trashSubtree } from '../../packages/core-records/src/tasks/trash.ts';
import { logTime, startTimer } from '../../packages/core-records/src/tasks/time.ts';
import { addTaskTag, createTag } from '../../packages/core-records/src/tasks/tags.ts';
import { isRecordsRefusal } from '../../packages/core-records/src/records/refusals.ts';
import {
  connect,
  type Database,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { createTask } from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('tag and time against a trash: DATABASE_URL is unset, so nothing below ran.');
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** A promise a test resolves by hand, which is how a transaction is held open. */
function barrier(): { readonly held: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

interface World {
  readonly db: FreshDatabase;
  /** A second connection: the first is `max: 1`, so two transactions on it would queue. */
  readonly second: Database;
  readonly business: string;
  readonly spine: InstalledTaskSpine;
  readonly person: { readonly personId: string; readonly actorId: string };
  readonly tagId: string;
}

let world: World | undefined;

const seeded = (): World => {
  if (world === undefined) throw new Error('the tag and time world was not seeded');
  return world;
};

/**
 * Wait, bounded, until some backend in this database is parked on a lock, or
 * the write has already answered without waiting.
 */
async function waitedOnLock(answered: () => boolean, deadline: number): Promise<boolean> {
  const rows = await seeded().db.admin.execute<{ readonly n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and state = 'active' and wait_event_type = 'Lock'`,
  );
  if ((rows[0]?.n ?? 0) > 0) return true;
  if (answered() || Date.now() > deadline) return false;
  await delay(25);
  return await waitedOnLock(answered, deadline);
}

/**
 * Trash a fresh task in a transaction held open, run `write` against it from
 * the second connection, let the trash commit once the write is waiting (or
 * has answered without waiting), and hand back the write's answer, whether it
 * waited, and what the task carries afterwards.
 */
async function againstTrash<T>(write: (tx: TenantQuery, taskId: string) => Promise<T>) {
  const { db, second, business, spine, person } = seeded();
  const taskId = await db.app.withBusiness(business, (tx) =>
    createTask(tx, spine, { title: 'contested', parentId: null }),
  );
  const open = barrier();
  const trashed = barrier();
  const trash = db.app.withBusiness(business, async (tx) => {
    const result = await trashSubtree(tx, { rootId: taskId, actorId: person.actorId });
    if (isRecordsRefusal(result)) throw new Error(result.code);
    trashed.release();
    await open.held;
  });
  await trashed.held;
  let answered = false;
  const writing = second
    .withBusiness(business, (tx) => write(tx, taskId))
    .finally(() => {
      answered = true;
    });
  const waited = await waitedOnLock(() => answered, Date.now() + 10_000);
  open.release();
  await trash;
  const answer = await writing;
  const left = await db.admin.execute<{ readonly tags: number; readonly entries: number }>(
    `select (select count(*)::int from public.task_tags where task_id = $1) as tags,
            (select count(*)::int from public.time_entries where task_id = $1) as entries`,
    [taskId],
  );
  return { answer, waited, left: left[0] };
}

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const db = await createFreshDatabase({ part: 'ttt' });
  const second = connect(db.appUrl, { source: 'runtime' });
  const business = await insertBusiness(db.app, 'tag-time-trash');
  world = await db.app.withBusiness(business, async (tx) => {
    const spine = await installTaskSpine(tx);
    const personId = await insertPerson(tx, 'a writer');
    const actorId = await insertActor(tx, personId);
    const tag = await createTag(tx, { name: 'Urgent', actorId });
    if (tag.kind !== 'created') throw new Error('tag not created');
    return { db, second, business, spine, person: { personId, actorId }, tagId: tag.tag.id };
  });
}, 60_000);

afterAll(async () => {
  await world?.second.close();
  await world?.db.drop();
});

describe.skipIf(serverUrl === undefined)('tag and time writes against a concurrent trash', () => {
  it('a tag add waits for the trash and answers no-task', async () => {
    const { tagId, person } = seeded();
    const { answer, waited, left } = await againstTrash((tx, taskId) =>
      addTaskTag(tx, { taskId, tagId, actorId: person.actorId }),
    );
    expect(answer).toBe('no-task');
    expect(left?.tags).toBe(0);
    expect(waited).toBe(true);
  });

  it('a timer start waits for the trash and answers no-task', async () => {
    const { person } = seeded();
    const { answer, waited, left } = await againstTrash((tx, taskId) =>
      startTimer(tx, { ...person, taskId }),
    );
    expect(answer.kind).toBe('no-task');
    expect(left?.entries).toBe(0);
    expect(waited).toBe(true);
  });

  it('a logged entry waits for the trash and answers no-task', async () => {
    const { person } = seeded();
    const { answer, waited, left } = await againstTrash((tx, taskId) =>
      logTime(tx, { ...person, taskId, minutes: 15, note: 'n' }),
    );
    expect(answer.kind).toBe('no-task');
    expect(left?.entries).toBe(0);
    expect(waited).toBe(true);
  });
});
