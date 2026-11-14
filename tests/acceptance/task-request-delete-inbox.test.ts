// SPDX-License-Identifier: AGPL-3.0-only
//
// #2360: an agent's request to delete a task tells a person in their inbox.
//
// `task.request_delete` raises one `delete_request` item in its own
// transaction: to the person the agent acts for when they hold `task:decide`
// on the task, else to the task's decide holders, never to a person who asked
// themselves. Confirm and Keep clear it in the answer's transaction, naming
// who answered. A lapsed request's item is not shown or counted, and is
// withdrawn when the lapse is recorded. The item stays inside its business
// and goes to no other person there.

import { describe, expect, it } from 'vitest';
import { serverUrl } from './world.ts';
import { CANARY, okay, openRequestWorld } from './task-request-delete-world.ts';

const w = openRequestWorld('task_request_delete_inbox_2360');
const h = w.harness;

interface ItemRow {
  readonly business: string;
  readonly recipient: string;
  readonly reason: string;
  readonly kind: string;
  readonly fact: string;
  readonly state: string;
  readonly closedBy: string | null;
}

/** Every inbox item about the task, from the database, any business. */
async function itemsOn(taskId: string): Promise<readonly ItemRow[]> {
  return await h().world.db.admin.execute<ItemRow>(
    `select business_id::text as business, recipient_person_id::text as recipient, reason,
            fact_kind as kind, fact_id::text as fact, work_state as state,
            closed_by_person_id::text as "closedBy"
       from public.inbox_items where subject_record_id = $1 order by raised_at, id`,
    [taskId],
  );
}

/** The open items a person's own inbox read shows about the task. */
async function shownTo(
  caller: { readonly token: string },
  taskId: string,
  businessKey = 'alpha',
): Promise<readonly Record<string, unknown>[]> {
  const read = await h().asPerson('inbox.read', {}, businessKey, caller);
  expect(read.code, read.text).toBe('ok');
  return (read.body['inbox'] as Record<string, unknown>[]).filter(
    (item) => item['subjectRecordId'] === taskId && item['workState'] === 'open',
  );
}

async function owedCount(caller: { readonly token: string }): Promise<number> {
  const read = await h().asPerson('inbox.count', {}, 'alpha', caller);
  expect(read.code, read.text).toBe('ok');
  return Number(read.body['owed']);
}

// eslint-disable-next-line max-lines-per-function -- one world, and the cases that share it
describe.skipIf(serverUrl === undefined)('a delete request in the inbox', () => {
  it('an agent request raises one owed item, to the person the agent acts for only', async () => {
    const { ada, mia, noah } = h().world;
    const task = await h().freshTask('a task an agent asks to delete, for the inbox');
    const before = await owedCount(ada);
    okay(await w.ask(task.id));
    const request = await w.requestIdOf(task.id);

    const items = await itemsOn(task.id);
    expect(items).toStrictEqual([
      {
        business: h().world.alpha,
        recipient: ada.personId,
        reason: 'delete_request',
        kind: 'delete_request',
        fact: request,
        state: 'open',
        closedBy: null,
      },
    ]);
    const shown = await shownTo(ada, task.id);
    expect(shown.map((item) => item['reason'])).toStrictEqual(['delete_request']);
    expect(await owedCount(ada)).toBe(before + 1);
    // Another person in the same business is told nothing, and reads nothing of it.
    for (const other of [mia, noah]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await shownTo(other, task.id)).toStrictEqual([]);
    }
  });

  it('Keep clears the item, naming who kept the task', async () => {
    const { ada } = h().world;
    const task = await h().freshTask('a task kept, for the inbox');
    okay(await w.ask(task.id));
    okay(await w.answer('task.decline_delete', task.id), 'Keep');
    const items = await itemsOn(task.id);
    expect(items.map((item) => [item.state, item.closedBy])).toStrictEqual([
      ['cleared', ada.personId],
    ]);
    expect(await shownTo(ada, task.id)).toStrictEqual([]);
  });

  it('Confirm clears the item in the same answer', async () => {
    const { ada } = h().world;
    const task = await h().freshTask('a task confirmed, for the inbox');
    okay(await w.ask(task.id));
    okay(await w.answer('task.confirm_delete', task.id), 'Confirm');
    const items = await itemsOn(task.id);
    expect(items.map((item) => [item.state, item.closedBy])).toStrictEqual([
      ['cleared', ada.personId],
    ]);
  });

  it('a refused Confirm leaves the item open, as it leaves the request', async () => {
    const task = await h().freshTask('a task whose confirm is refused, for the inbox');
    okay(await w.ask(task.id));
    const stale = await w.answer('task.confirm_delete', task.id, {
      requestId: '00000000-0000-4000-8000-000000000000',
    });
    expect(stale.code).toBe('DELETE_REQUEST_NOT_PENDING');
    expect((await itemsOn(task.id)).map((item) => item.state)).toStrictEqual(['open']);
  });

  it('a lapsed request is neither shown nor counted, and is withdrawn when the lapse is recorded', async () => {
    const { ada } = h().world;
    const task = await h().freshTask('a task whose request lapses, for the inbox');
    okay(await w.ask(task.id));
    const before = await owedCount(ada);
    await h().world.db.admin.execute(
      `update public.task_delete_requests
          set requested_at = now() - interval '8 days', expires_at = now() - interval '1 day'
        where task_id = $1`,
      [task.id],
    );
    expect(await shownTo(ada, task.id), 'a lapsed request is not shown').toStrictEqual([]);
    expect(await owedCount(ada)).toBe(before - 1);

    okay(await w.ask(task.id), 'a new request after the old one lapsed');
    const items = await itemsOn(task.id);
    expect(items.map((item) => item.state)).toStrictEqual(['withdrawn', 'open']);
    expect(items[1]?.fact).toBe(await w.requestIdOf(task.id));
    expect(await shownTo(ada, task.id)).toHaveLength(1);
  });

  it('a person who asks is not told; the task’s decide holders are', async () => {
    const { ada, mia } = h().world;
    const task = await h().freshTask('a task a person asks to delete, for the inbox');
    const asked = await h().asPerson(
      'task.request_delete',
      { recordId: task.id, expectedRevision: await w.revisionOf(task.id), reason: 'mine' },
      'alpha',
      ada,
    );
    okay(asked, 'Ada asks herself');
    const recipients = (await itemsOn(task.id)).map((item) => item.recipient);
    expect(recipients).not.toContain(ada.personId);
    expect(recipients).not.toContain(mia.personId);
  });

  it('a request in another business tells only that business’s people', async () => {
    const { ada, bea } = h().world;
    const created = await h().asPerson(
      'task.create',
      { fields: { title: `${CANARY} a bravo task for the inbox` } },
      'bravo',
      bea,
    );
    const taskId = String(created.body['recordId']);
    const asked = await w.asCredential(
      'task.request_delete',
      { recordId: taskId, expectedRevision: await w.revisionOf(taskId), reason: 'bravo asks' },
      w.bravoSecret(),
      'bravo',
    );
    okay(asked, 'bravo’s agent asks');
    const items = await itemsOn(taskId);
    expect(items.map((item) => [item.business, item.recipient])).toStrictEqual([
      [h().world.bravo, bea.personId],
    ]);
    expect(await shownTo(bea, taskId, 'bravo')).toHaveLength(1);
    const alphaInbox = await h().asPerson('inbox.read', {}, 'alpha', ada);
    expect(alphaInbox.text).not.toContain(taskId);
    expect(alphaInbox.text).not.toContain(CANARY);
  });
});
