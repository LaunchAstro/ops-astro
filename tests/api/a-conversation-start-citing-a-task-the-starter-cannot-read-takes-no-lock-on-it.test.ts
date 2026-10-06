// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.start` citing a task asks `task:read` before it takes the
// task's row (`conversations.ts` `citable`): a starter who cannot read the
// task is answered `NOT_FOUND` without waiting on a task write that holds the
// row, so the wait tells them nothing of the task and they hold no lock on it
// (security re-bind SEC-B1B-R7 R7-1, #444).
//
// The task row is held `for update` on another connection, as a task write
// holds it; the start must answer while it is held, never parked behind it.

import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow, isWaitedOn, type Held } from '../support/lock-wait-race.ts';
import { CONVERSATION, conversationWorld, type ConversationWorld } from './aw-03-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** Polls until `settled` answers or the held row is waited on; answers whether it settled first. */
async function answeredWhileHeld(
  w: ConversationWorld,
  held: Held<unknown>,
  settled: () => boolean,
): Promise<{ readonly answered: boolean; readonly waited: boolean }> {
  let waited = false;
  for (let attempt = 0; attempt < 500 && !settled() && !waited; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    waited = await isWaitedOn(w.fixture.db, held);
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    if (!settled() && !waited) await delay(10);
  }
  return { answered: settled(), waited };
}

describe.skipIf(serverUrl === undefined)('citing a task the starter cannot read', () => {
  let w: ConversationWorld;
  beforeAll(async () => {
    w = await conversationWorld('start_unreadable_cite');
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
  });

  it('a conversation start citing a task the starter cannot read is refused without waiting on its row', async () => {
    const created = await w.as(w.owner, 'task.create', { fields: { title: 'Not theirs to read' } });
    const taskId = (created.body as { recordId: string }).recordId;
    const { db, business } = w.fixture;
    // Their own conversations, and no task grant at all.
    const stranger = await enrol(db.app, business, 'conversation-only');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, stranger, 'write', undefined, false, CONVERSATION);
    });
    const kept = 'select count(*) as n from public.conversations where scope_record_id = $1';
    const held = await holdRow(db, 'select id from public.records where id = $1 for update', [
      taskId,
    ]);
    let settled = false;
    const starting = w
      .as(stranger, 'conversation.start', {
        body: 'Citing a task I cannot read',
        scope: { kind: 'task', id: taskId },
      })
      .then((answer) => {
        settled = true;
        return answer;
      });
    let seen = { answered: false, waited: false };
    try {
      seen = await answeredWhileHeld(w, held, () => settled);
    } finally {
      await held.letGo();
    }
    const answer = await starting;
    expect({
      ...seen,
      status: answer.status,
      code: answer.body['code'],
      kept: await w.count(kept, [taskId]),
    }).toEqual({ answered: true, waited: false, status: 404, code: 'NOT_FOUND', kept: 0 });
  }, 30_000);
});
