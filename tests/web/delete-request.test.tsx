// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// #2359: the task page shows an agent's open request to delete it, with who
// asked and why, and answers it with Confirm delete or Keep, naming the
// request it answers (#2362) at the page's revision. A refusal is quoted and
// the request stays in view; no request draws nothing.

import { afterEach, expect, it } from 'vitest';
import { DeleteRequest } from '../../apps/web/src/screens/task/DeleteRequest.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { TASK_ID, found, page as taskPage, tick } from './task-page-stub.tsx';

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const REQUEST = {
  id: '6a1f6d2e-0d7b-4c3e-9a51-2f4b8c9d0e11',
  reason: 'It was a test task.',
  byAgent: true,
  requestedBy: 'Hermes',
  requestedAt: '2026-11-01T00:00:00.000Z',
  expiresAt: '2026-11-08T00:00:00.000Z',
};

async function page(
  answer: { readonly body: unknown; readonly status: number },
  request: typeof REQUEST | null = REQUEST,
) {
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
  const answered = { count: 0 };
  const view = await mount(
    <DeleteRequest
      client={client}
      task={{ id: TASK_ID, revision: 7, deleteRequest: request }}
      disabled={false}
      onAnswered={() => {
        answered.count += 1;
      }}
    />,
  );
  return { view, sent, answered };
}

const APPLIED = { body: { ok: true, recordId: TASK_ID, revision: 8, detail: {} }, status: 200 };

afterEach(unmountAll);

it('shows who asks to delete the task and why, and draws nothing with no request', async () => {
  const { view } = await page(APPLIED);
  expect(view.text()).toContain('Hermes asks to delete this task');
  expect(view.text()).toContain('It was a test task.');
  expect(view.text()).toContain('can be restored');
  const none = await page(APPLIED, null);
  expect(none.view.find('[data-delete-request]')).toBeNull();
});

it('names an agent with no name as an agent', async () => {
  const { view } = await page(APPLIED, { ...REQUEST, requestedBy: '' });
  expect(view.text()).toContain('An agent asks to delete this task');
});

it.each([
  ['confirm-delete', 'task.confirm_delete'],
  ['keep', 'task.decline_delete'],
])(
  '%s sends %s for this request at the page revision, then hands the page back',
  async (act, command) => {
    const { view, sent, answered } = await page(APPLIED);
    await view.click(`[data-act="${act}"] button`);
    await tick();
    expect(
      sent.map((one) => [
        one.command,
        one.body['recordId'],
        one.body['requestId'],
        one.body['expectedRevision'],
      ]),
    ).toStrictEqual([[command, TASK_ID, REQUEST.id, 7]]);
    expect(answered.count).toBe(1);
  },
);

it.each([
  [
    'confirm-delete',
    'TASK_NOT_DELETABLE',
    'Cancel its run instead, or complete the task. Its history stays with it.',
  ],
  ['keep', 'DELETE_REQUEST_NOT_PENDING', 'Read the task again.'],
])('quotes a refusal at %s (%s) and keeps the request in view', async (act, code, fix) => {
  const { view, answered } = await page({
    body: { refused: true, code, names: ['recordId'], fixes: [fix] },
    status: 409,
  });
  await view.click(`[data-act="${act}"] button`);
  await tick();
  expect(view.find('[data-delete-request-refused]')?.textContent).toContain(fix);
  expect(view.find('[data-delete-request]')).not.toBeNull();
  expect(answered.count).toBe(0);
});

it('the task page shows the request its read carries, and nothing without one', async () => {
  const asked = await taskPage('Proj-Verity-Pacing', found({ deleteRequest: REQUEST }));
  expect(asked.text()).toContain('Hermes asks to delete this task');
  expect(asked.find(`[data-delete-request="${REQUEST.id}"] [data-act="keep"]`)).not.toBeNull();
  unmountAll();
  const plain = await taskPage('Proj-Verity-Pacing', found({ deleteRequest: null }));
  expect(plain.find('[data-delete-request]')).toBeNull();
});
