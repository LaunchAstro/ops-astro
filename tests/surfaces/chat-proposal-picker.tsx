// SPDX-License-Identifier: AGPL-3.0-only
//
// #1666: what the picker card's tests share. A chat opened on no task gets an
// edit reply carrying the server's targets (`ConversationTargetsView`): the
// tasks this conversation created, each at the revision kept with the reply.
// The person picks among them on the card; the model never names one.

import { block, ok, type Answer } from './chat-proposal-drawer.tsx';
import { settle, type Mounted } from './mount.tsx';

export const EDIT_REPLY = '77777777-7777-4777-8777-777777777777';
export const FIRST = '66666666-6666-4666-8666-666666666666';
export const SECOND = '88888888-8888-4888-8888-888888888888';
export const FORGED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const RENAME = '{"action":"edit","title":"Book the printer for Friday"}';

/** The targets of a reply: `pick`, then each task by position, id and revision. */
export const targets = (
  required: boolean,
  ...tasks: readonly (readonly [number, string, number])[]
): Answer => ({
  pick: required,
  tasks: tasks.map(([n, taskId, revision]) => ({ n, taskId, revision })),
});

export const ONE = targets(false, [1, FIRST, 2]);
export const TWO = targets(true, [1, FIRST, 2], [2, SECOND, 5]);

/** An edit reply in a chat on no task, with the targets the server kept for it. */
export const editing = (targetsOf: unknown, json = RENAME): Answer => ({
  answered: true,
  messageId: EDIT_REPLY,
  body: block(json),
  targets: targetsOf,
});

/** `task.read` of one task as it is now. */
export const taskNow = (id: string, key: string, title: string, revision = 9): Answer =>
  ok({ ok: true, task: { id, key, title, revision } });

/** Six tasks a chat created, each its own id, key and title. */
export const SIX = Array.from({ length: 6 }, (_unused, at) => ({
  id: `c0c0c0c0-0000-4000-8000-00000000000${String(at + 1)}`,
  key: `T-4${String(at + 1)}`,
  title: `Task number ${String(at + 1)}`,
}));

export const READS: Readonly<Record<string, Answer>> = {
  [FIRST]: taskNow(FIRST, 'T-31', 'Book the printer'),
  [SECOND]: taskNow(SECOND, 'T-32', 'Order the paper'),
  ...Object.fromEntries(SIX.map((each) => [each.id, taskNow(each.id, each.key, each.title)])),
};

/** Lets the card's reads land: each is a promise or two deep. */
export async function landed(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- one act() scope at a time
    await settle();
  }
}

/** The rows the picker shows, as text. */
export const rowsOf = (page: Mounted): readonly string[] =>
  page.all('[data-proposal="row"]').map((row) => row.textContent ?? '');

/** The person picks the row for `taskId`. */
export async function pick(page: Mounted, taskId: string): Promise<void> {
  await page.click(`[data-proposal="option"][value="${taskId}"]`);
  await landed();
}

export const sendButton = (page: Mounted): HTMLButtonElement | null =>
  page.find('[data-proposal="send"]') as HTMLButtonElement | null;

/** The task ids `task.read` was asked for, in order. */
export const taskReads = (
  reads: readonly { readonly name: string; readonly body: Answer }[],
): readonly unknown[] =>
  reads.filter((each) => each.name === 'task.read').map((each) => each.body['recordId']);

/** The `task.update` a click on the reply's card sends for `taskId` at `revision`. */
export const update = (taskId: string, revision: number) => ({
  name: 'task.update',
  body: { recordId: taskId, fields: { title: 'Book the printer for Friday' } },
  options: { operationId: `task-proposal:${EDIT_REPLY}`, expectedRevision: revision },
});
