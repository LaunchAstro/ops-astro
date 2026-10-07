// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.add_tag` and `task.remove_tag` are admitted on `task:write` of the
// task, and `time.start` and `time.log` on `time:write` of the business; each
// then holds the task's row (`for share`) before it writes, so it waits while
// another transaction holds that row. A grant that expires during that wait
// no longer counts: the write is refused `SCOPE_NOT_GRANTED` and nothing is
// written (#443).
//
// The task row is held `for update` on another connection without trashing
// it; the write is seen waiting on that holder with its transaction begun
// before the grant's expiry; the holder lets go once the database clock is
// past it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTag } from '../../packages/core-records/src/tasks/tags.ts';
import { grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { blockedBefore, holdRow, waitPast } from '../support/lock-wait-race.ts';
import { conversationWorld, expiringSoon, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Case {
  readonly command: 'task.add_tag' | 'task.remove_tag' | 'time.start' | 'time.log';
  readonly collection: 'task' | 'time';
  /** Rows the write would leave on the task: its tags, or its time entries. */
  readonly left: string;
  /** What the task carries before the write, as the left count. */
  readonly before: number;
}

const TAGS = 'select count(*) as n from public.task_tags where task_id = $1';
const ENTRIES = 'select count(*) as n from public.time_entries where task_id = $1';

const CASES: readonly Case[] = [
  { command: 'task.add_tag', collection: 'task', left: TAGS, before: 0 },
  { command: 'task.remove_tag', collection: 'task', left: TAGS, before: 1 },
  { command: 'time.log', collection: 'time', left: ENTRIES, before: 0 },
  { command: 'time.start', collection: 'time', left: ENTRIES, before: 0 },
];

let w: ConversationWorld;
let tagId: string;

const write = (taskId: string, command: Case['command']): Record<string, unknown> => {
  if (command === 'time.log') return { taskId, duration: '15m', note: 'n' };
  if (command === 'time.start') return { taskId };
  return { recordId: taskId, tagId };
};

/**
 * The colleague's write on a new task, sent while the task row is held and
 * their one covering grant runs out: whether it was seen waiting before the
 * expiry, what it answered, and what the task carries afterwards.
 */
async function writeAcross(one: Case) {
  const person = w.colleague;
  const created = await w.as(w.owner, 'task.create', {
    fields: { title: `${one.command} across a grant expiry` },
  });
  const taskId = (created.body as { recordId: string }).recordId;
  if (one.before > 0) {
    const carried = await w.as(w.owner, 'task.add_tag', {
      operationId: randomUUID(),
      recordId: taskId,
      tagId,
    });
    expect(carried.status).toBe(200);
  }
  const db = w.fixture.db;
  const grant = await expiringSoon(w, person.personId, one.collection, 'write');
  const held = await holdRow(db, 'select id from public.records where id = $1 for update', [
    taskId,
  ]);
  const writing = w.as(person, one.command, {
    operationId: randomUUID(),
    ...write(taskId, one.command),
  });
  let waitedLive = false;
  try {
    waitedLive = await blockedBefore(db, held, grant.expiry);
    await waitPast(db, grant.expiry);
  } finally {
    await held.letGo();
  }
  const answer = await writing;
  const seen = {
    waitedLive,
    status: answer.status,
    code: answer.body['code'],
    left: await w.count(one.left, [taskId]),
  };
  // The grant stands again for the next case.
  await db.admin.execute('update public.grants set expires_at = null where id = $1', [grant.id]);
  return seen;
}

describe.skipIf(serverUrl === undefined)(
  'a grant expiring while a tag or time write waits for its task row',
  () => {
    beforeAll(async () => {
      w = await conversationWorld('tag_time_grant_expiry');
      tagId = await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
        await grantTo(tx, w.colleague, 'write');
        await grantTo(tx, w.colleague, 'write', undefined, false, 'time');
        const tag = await createTag(tx, { name: 'Urgent', actorId: w.owner.actorId });
        if (tag.kind !== 'created') throw new Error('tag not created');
        return tag.tag.id;
      });
    }, 180_000);
    afterAll(async () => {
      await w?.drop();
    });

    it.each(CASES)(
      '$command refuses a $collection:write grant that expires while it waits for the task row',
      async (one) => {
        expect(await writeAcross(one)).toEqual({
          waitedLive: true,
          status: 403,
          code: 'SCOPE_NOT_GRANTED',
          left: one.before,
        });
      },
      30_000,
    );
  },
);
