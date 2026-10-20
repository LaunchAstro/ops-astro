// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A chat proposal's edit applies only to the chat's own task: the task the
// conversation was started on. The question in a task chat now waits for its
// task's read before `conversation.start` leaves, and the start's scope is read
// when it leaves. A person who selects another tab while that read is out must
// not change which task the conversation is on, or the edit card applies to a
// task the conversation never was on. The operations client stands in for the
// network only.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const GRANT = 'alpha:ada';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const REPLY = '99999999-9999-4999-8999-999999999999';
const TASK_A = {
  id: '55555555-5555-4555-8555-555555555555',
  title: 'Spring brief',
  clientId: null,
};
const TASK_B = {
  id: '66666666-6666-4666-8666-666666666666',
  title: 'Autumn brief',
  clientId: null,
};
const EDIT =
  'Here is the change.\n\n```task\n{"action":"edit","title":"Spring brief, second draft"}\n```';

type Answer = Readonly<Record<string, unknown>>;

function slowTaskRead() {
  const sent: { readonly name: string; readonly body: Answer }[] = [];
  const gate: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const release = (): void => gate.release?.();
  const client = {
    newOperationId: () => 'op-fresh-1',
    read: async (name: string, body: Answer) => {
      if (name !== 'task.read') return { unavailable: true, because: 'not asked here' };
      await held;
      const id = body['recordId'];
      return { ok: true, value: { ok: true, task: { id, key: 'T-12', title: 'x', revision: 7 } } };
    },
    mutate: (name: string, body: Answer) => {
      sent.push({ name, body });
      const reply =
        name === 'conversation.start'
          ? { answered: true, messageId: REPLY, body: EDIT }
          : undefined;
      return Promise.resolve({
        ok: true,
        value: {
          recordId: '',
          revision: 0,
          detail: { conversationId: CONVERSATION },
          ...(reply === undefined ? {} : { reply }),
        },
      });
    },
  } as unknown as OperationsClient;
  return { client, sent, release };
}

async function opened(client: OperationsClient) {
  askDrawer(taskAsk(TASK_A), GRANT);
  const page = track(
    await mount(
      <AssistantView
        grantKey={GRANT}
        client={client}
        route="agency:task-detail"
        here="/task/T-12"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  return page;
}

describe('chat proposal edit and the conversation’s task', () => {
  it('a tab selected while the question’s task read is out leaves the conversation on the asking tab’s task', async () => {
    const { client, sent, release } = slowTaskRead();
    const page = await opened(client);
    // A second tab, on another task, opened by a later ask.
    await act(() => {
      askDrawer(taskAsk(TASK_B), GRANT);
    });
    await settle();
    await page.click('[data-chat="chat-2"]');
    await page.type('[data-assistant="input"]', 'Rename this for the second draft');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    // The person looks at the other tab while the task read is out.
    await page.click('[data-chat="chat-3"]');
    release();
    await settle();
    await settle();
    const start = sent.find((each) => each.name === 'conversation.start');
    // The edit card in chat-2 applies to Task A: the conversation must be on Task A.
    expect(start?.body['scope']).toStrictEqual({ kind: 'task', id: TASK_A.id });
  });

  it('a tab on no task selected while the question’s task read is out does not start the conversation on no task under an edit card', async () => {
    const { client, sent, release } = slowTaskRead();
    const page = await opened(client);
    await page.type('[data-assistant="input"]', 'Rename this for the second draft');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    // The drawer's first tab is on no task.
    await page.click('[data-chat="chat-1"]');
    release();
    await settle();
    await settle();
    await page.click('[data-chat="chat-2"]');
    const start = sent.find((each) => each.name === 'conversation.start');
    const card = page.find('[data-proposal="card"]');
    // An edit card is drawn only for a conversation on a task, and that task is the card's.
    expect({ scope: start?.body['scope'], card: card?.getAttribute('data-action') }).toStrictEqual({
      scope: { kind: 'task', id: TASK_A.id },
      card: 'edit',
    });
  });
});
