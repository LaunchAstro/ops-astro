// SPDX-License-Identifier: AGPL-3.0-only
//
// Finding 1: a business installed before the comment type existed can acquire it.
//
// The Base installer (`e47596c`) wrote `task` and `task_state` and no
// `task_comment`, and neither migration 0008 nor 0009 installs comment
// metadata into a business that already exists. So the live shape for every
// existing business is exactly that, and the only producer that could bring it
// forward is this installer — which used to treat the shape as corruption and
// throw.
//
// The Base shape is built here the way the review describes it: run the current
// installer, then delete the comment type and its fields inside the test's own
// transaction. That is a truer reconstruction than re-implementing the old
// installer, because it leaves the task and state rows byte-identical to what
// the current code writes and removes only the thing Base never wrote.
//
// Three assertions carry the finding. The upgrade adds the comment type with
// its eight fields. The task and state type ids, their field rows and the task
// records are untouched by it. A second call changes nothing at all.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { installTaskSpine } from '../../packages/core-records/src/tasks/install.ts';
import { COMMENT_TYPE_KEY } from '../../packages/core-records/src/tasks/comments.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { insertBusiness } from '../identity/fixture.ts';
import type { TenantQuery } from '../../packages/core-records/src/tenancy/database.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Every comment field the spine ships, by name, so the count alone cannot pass this. */
const COMMENT_FIELDS = [
  'audience',
  'author',
  'body',
  'comment_type',
  'edited_at',
  'posted_at',
  'source',
  'task',
];

interface TypeRow {
  readonly id: string;
  readonly key: string;
}

async function typesOf(tx: TenantQuery, business: string): Promise<readonly TypeRow[]> {
  return await tx.query<TypeRow>(
    `select id, key from record_types where business_id = $1 order by key`,
    [business],
  );
}

async function fieldKeysOf(tx: TenantQuery, typeId: string): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly key: string }>(
    `select key from field_defs where record_type_id = $1 order by key`,
    [typeId],
  );
  return rows.map((row) => row.key);
}

describe.skipIf(serverUrl === undefined)('installTaskSpine upgrades a Base-shaped business', () => {
  let db: FreshDatabase;
  let business: string;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l2u' });
    business = await insertBusiness(db.app, 'base-shaped');
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('adds the comment type, preserves the task spine, and is stable on a second call', async () => {
    await db.app.withBusiness(business, async (tx) => {
      // 1. Install fully, then reduce to the Base shape by removing the comment
      //    type. What remains is what the live databases hold.
      const first = await installTaskSpine(tx);
      const taskFieldsBefore = await fieldKeysOf(tx, first.taskTypeId);
      const stateFieldsBefore = await fieldKeysOf(tx, first.taskStateTypeId);

      // A task record, so "the records survive" is asserted against a real row
      // rather than against an empty table.
      const taskId = randomUUID();
      await tx.query(
        `insert into records (business_id, id, record_type_id, data) values ($1, $2, $3, $4)`,
        [business, taskId, first.taskTypeId, { title: 'a task that predates comments' }],
      );

      await tx.query(`delete from field_defs where record_type_id = $1`, [first.taskCommentTypeId]);
      await tx.query(`delete from record_types where business_id = $1 and id = $2`, [
        business,
        first.taskCommentTypeId,
      ]);
      expect((await typesOf(tx, business)).map((row) => row.key)).toStrictEqual([
        'task',
        'task_state',
      ]);

      // 2. The upgrade. Against `b96b487` this throws
      //    'the task type is installed and the comment type is not'.
      const upgraded = await installTaskSpine(tx);

      expect(upgraded.taskTypeId).toBe(first.taskTypeId);
      expect(upgraded.taskStateTypeId).toBe(first.taskStateTypeId);
      expect(upgraded.installed).toBe(false);
      expect(upgraded.taskCommentTypeId).not.toBe(first.taskCommentTypeId);

      const commentType = (await typesOf(tx, business)).find((row) => row.key === COMMENT_TYPE_KEY);
      expect(commentType?.id).toBe(upgraded.taskCommentTypeId);
      expect(await fieldKeysOf(tx, upgraded.taskCommentTypeId)).toStrictEqual(COMMENT_FIELDS);

      // Nothing of the task spine moved.
      expect(await fieldKeysOf(tx, first.taskTypeId)).toStrictEqual(taskFieldsBefore);
      expect(await fieldKeysOf(tx, first.taskStateTypeId)).toStrictEqual(stateFieldsBefore);
      expect(upgraded.stateIds).toStrictEqual(first.stateIds);
      const surviving = await tx.query<{ readonly title: string }>(
        `select data ->> 'title' as title from records where business_id = $1 and id = $2`,
        [business, taskId],
      );
      expect(surviving[0]?.title).toBe('a task that predates comments');

      // 3. Stability: the same call again writes nothing.
      const typesBefore = await typesOf(tx, business);
      const again = await installTaskSpine(tx);
      expect(again).toStrictEqual(upgraded);
      expect(await typesOf(tx, business)).toStrictEqual(typesBefore);
      expect(await fieldKeysOf(tx, upgraded.taskCommentTypeId)).toStrictEqual(COMMENT_FIELDS);
    });
  }, 60_000);
});
