// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #2345: the task page's Delete asks first, says the task can be restored,
// sends `task.delete` only on the second press, and quotes a refusal.

import { afterEach, expect, it } from 'vitest';
import { DeleteTask } from '../../apps/web/src/screens/task/DeleteTask.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function server(answer: { readonly body: unknown; readonly status: number }) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    sent.push({
      command: at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.'),
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'],
    });
    return Promise.resolve(json(answer.body, answer.status));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { client, sent };
}

async function deleting(answer: { readonly body: unknown; readonly status: number }) {
  const { client, sent } = server(answer);
  const deleted = { count: 0 };
  const view = await mount(
    <DeleteTask
      client={client}
      task={{ id: TASK_ID, revision: 7 }}
      disabled={false}
      onDeleted={() => {
        deleted.count += 1;
      }}
    />,
  );
  return { view, sent, deleted };
}

const APPLIED = { body: { ok: true, recordId: TASK_ID, revision: 8, detail: {} }, status: 200 };

afterEach(unmountAll);

it('asks first, says it can be restored, and Keep sends nothing', async () => {
  const { view, sent } = await deleting(APPLIED);
  await view.click('[data-act="ask-delete"] button');
  expect(view.find('[data-confirm="delete-task"]')).not.toBeNull();
  expect(view.text()).toContain('it can be restored');
  await view.click('[data-act="keep"] button');
  expect(view.find('[data-confirm="delete-task"]')).toBeNull();
  expect(sent).toStrictEqual([]);
});

it('sends task.delete at the page revision on the second press, then hands the page back', async () => {
  const { view, sent, deleted } = await deleting(APPLIED);
  await view.click('[data-act="ask-delete"] button');
  await view.click('[data-act="delete"] button');
  await tick();
  expect(
    sent.map(({ command, body }) => [command, body['recordId'], body['expectedRevision']]),
  ).toStrictEqual([['task.delete', TASK_ID, 7]]);
  expect(deleted.count).toBe(1);
});

it('quotes a refusal and keeps the task', async () => {
  const { view, deleted } = await deleting({
    body: {
      refused: true,
      code: 'TASK_NOT_DELETABLE',
      names: ['work'],
      fixes: ['Cancel it instead: set its status to a cancelled one. Its history stays with it.'],
    },
    status: 409,
  });
  await view.click('[data-act="ask-delete"] button');
  await view.click('[data-act="delete"] button');
  await tick();
  expect(view.find('[data-task-delete-refused]')?.textContent).toContain('Cancel it instead');
  expect(deleted.count).toBe(0);
});
