// SPDX-License-Identifier: AGPL-3.0-only
//
// A task id is accepted in either letter case (`isUuid`), and Postgres reads
// both spellings as one uuid, but the stored ids and the ids a comment carries
// are lowercase text. A task read handed the uppercase spelling must answer
// exactly as it does for the lowercase one: the same comments, the same own
// row in its family and its rank, and the shared view with its client
// comments, never an empty thread or a parent read back as its own child.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readSharedTask } from '../../packages/core-commands/src/reads/tasks.ts';
import { readTaskRank } from '../../packages/core-commands/src/reads/rank.ts';
import { readTaskComments } from '../../packages/core-records/src/tasks/comment-thread.ts';
import { writeComment } from '../../packages/core-records/src/tasks/comments.ts';
import { readTaskFamily } from '../../packages/core-records/src/tasks/family.ts';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { createTask } from '../tasks/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('task reads in either letter case: DATABASE_URL is unset, so nothing below ran.');
}

interface World {
  readonly db: FreshDatabase;
  readonly business: string;
  readonly taskTypeId: string;
  readonly commentTypeId: string;
  readonly parentId: string;
}

let world: World | undefined;

const seeded = (): World => {
  if (world === undefined) throw new Error('the letter case world was not seeded');
  return world;
};

const inBusiness = async <T>(work: (tx: TenantQuery) => Promise<T>): Promise<T> =>
  await seeded().db.app.withBusiness(seeded().business, work);

/** The same read with the lowercase id and the uppercase one. */
const bothSpellings = async <T>(read: (tx: TenantQuery, id: string) => Promise<T>) => {
  const { parentId } = seeded();
  expect(parentId, 'the id has letters to change case').not.toBe(parentId.toUpperCase());
  return await inBusiness(async (tx) => ({
    lower: await read(tx, parentId),
    upper: await read(tx, parentId.toUpperCase()),
  }));
};

beforeAll(async () => {
  if (serverUrl === undefined) return;
  const db = await createFreshDatabase({ part: 'tlc' });
  const business = await insertBusiness(db.app, 'letter-case');
  world = await db.app.withBusiness(business, async (tx) => {
    const spine = await installTaskSpine(tx);
    const actorId = await insertActor(tx, await insertPerson(tx, 'Ada'));
    const parentId = await createTask(tx, spine, { title: 'parent', parentId: null });
    await createTask(tx, spine, { title: 'step', parentId });
    await writeComment(tx, spine.taskCommentTypeId, {
      taskId: parentId,
      authorActorId: actorId,
      commentType: 'client',
      audience: 'client',
      body: 'sent to the client',
      source: 'app',
    });
    // Impact, confidence and ease, so the rank has a score and a number to compare.
    await tx.query(
      `update public.records set data = data || '{"impact":5,"confidence":5,"ease":5}'::jsonb
        where id = $1`,
      [parentId],
    );
    return {
      db,
      business,
      taskTypeId: spine.taskTypeId,
      commentTypeId: spine.taskCommentTypeId,
      parentId,
    };
  });
}, 60_000);

afterAll(async () => {
  await world?.db.drop();
});

describe.skipIf(serverUrl === undefined)('a task read takes its id in either letter case', () => {
  it('reads the same comments', async () => {
    const { lower, upper } = await bothSpellings((tx, id) =>
      readTaskComments(tx, seeded().commentTypeId, id),
    );
    expect(lower).toHaveLength(1);
    expect(upper).toStrictEqual(lower);
  });

  it('finds the task itself in its family, never as its own child', async () => {
    const { lower, upper } = await bothSpellings((tx, id) =>
      readTaskFamily(tx, seeded().taskTypeId, id, []),
    );
    expect(lower.parent?.id).toBe(seeded().parentId);
    expect(upper).toStrictEqual(lower);
  });

  it('finds the task itself in its rank', async () => {
    const { lower, upper } = await bothSpellings((tx, id) =>
      readTaskRank(tx, seeded().taskTypeId, id, { kind: 'task' }),
    );
    expect(lower.score, 'the task’s own row is scored in its pool').not.toBeNull();
    expect(lower.number).toBe(1);
    expect(upper).toStrictEqual(lower);
  });

  it('shows the shared view with its client comments and the stored id', async () => {
    const { lower, upper } = await bothSpellings((tx, id) =>
      readSharedTask(tx, seeded().taskTypeId, id, seeded().commentTypeId),
    );
    expect(lower?.id).toBe(seeded().parentId);
    expect(lower?.comments).toHaveLength(1);
    expect(upper).toStrictEqual(lower);
  });
});
