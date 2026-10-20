// SPDX-License-Identifier: AGPL-3.0-only
//
// A task created from a conversation after its quiet wrap-up was written is
// activity in that conversation, as a message and a plan accept are. The
// wrap-up written before it no longer covers it, and the next wrap-up, at the
// next quiet, lists the task.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/index.ts';
import {
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import { changed, fingerprint, undeclared } from '../operations/s0-5-effect-diff.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'api/a-task-created-after-the-wrap-up-is-conversation-activity: DATABASE_URL is unset, so nothing below ran.',
  );
}

interface ServedWrapUp {
  readonly version: number;
  readonly items: readonly { key: string; pointers: readonly { id: string }[] }[];
}
const pointerIds = (wrapUp: ServedWrapUp, key: string): readonly string[] =>
  wrapUp.items.find((item) => item.key === key)?.pointers.map((pointer) => pointer.id) ?? [];

// eslint-disable-next-line max-lines-per-function -- one world, two cases
describe.skipIf(serverUrl === undefined)('a task created after the wrap-up', () => {
  let w: ConversationWorld;
  beforeAll(async () => {
    w = await conversationWorld('task_after_wrap');
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await setConversationWindow(tx, 7);
    });
  }, 180_000);
  afterAll(async () => {
    await w?.drop();
  });
  const wrap = async (conversationId: string) =>
    await w.fixture.db.app.withBusiness(
      w.fixture.business,
      async (tx) => await writeWrapUp(tx, { conversationId, codeRevision: 'taskafterwrap' }),
    );

  it('a task created from the conversation after its quiet wrap-up reaches the next wrap-up', async () => {
    const conversationId = await started(w, w.owner, { body: 'Make a task after the wrap-up' });
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 1, written: true });
    const created = await w.as(w.owner, 'task.create', {
      fields: { title: 'made after the wrap-up' },
      conversationId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const taskId = (created.body as { recordId: string }).recordId;
    // The create is activity in the conversation: version 1 no longer covers
    // it, and the next wrap-up comes at quiet.
    expect(await wrap(conversationId)).toEqual({ ok: false, reason: 'not_quiet' });
    await w.age(conversationId, 8);
    expect(await wrap(conversationId)).toEqual({ ok: true, version: 2, written: true });
    const read = await w.as(w.owner, 'conversation.read', { conversationId });
    expect(read.status).toBe(200);
    const wrapUp = read.body['wrapUp'] as ServedWrapUp;
    expect({ version: wrapUp.version, tasks: pointerIds(wrapUp, 'tasks_created') }).toEqual({
      version: 2,
      tasks: [taskId],
    });
  });

  it('a create from a conversation declares the conversation it moves among its writes', async () => {
    const conversationId = await started(w, w.owner, {
      body: 'Make a task, and say what it writes',
    });
    const before = await fingerprint(w.fixture.db.admin);
    const created = await w.as(w.owner, 'task.create', {
      fields: { title: 'its create effect-proved' },
      conversationId,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const written = changed(before, await fingerprint(w.fixture.db.admin));
    expect(written).toContain('conversations');
    expect(undeclared('task.create', written)).toEqual([]);
  });
});
