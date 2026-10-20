// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A question in a task chat now waits for its task's read before it leaves.
// The model the question is asked of is the one chosen when the person sent
// it ("a model just chosen is the one asked"): a model chosen after Enter, while
// that read is out, is for the next question, so `conversation.message` leaves
// before that `conversation.set_model`, as it did before the read was added.
// The operations client stands in for the network only.

import { afterEach, describe, expect, it } from 'vitest';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const GRANT = 'alpha:ada';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const TASK = { id: '55555555-5555-4555-8555-555555555555', title: 'Spring brief', clientId: null };

type Answer = Readonly<Record<string, unknown>>;

function recorder() {
  const order: string[] = [];
  let reads = 0;
  const gate: { release?: () => void } = {};
  const held = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const release = (): void => gate.release?.();
  const client = {
    newOperationId: () => 'op-fresh-1',
    read: async (name: string) => {
      if (name === 'conversation.models') {
        return { ok: true, value: { models: [{ id: 'model-a' }, { id: 'model-b' }] } };
      }
      if (name !== 'task.read') return { unavailable: true, because: 'not asked here' };
      reads += 1;
      // The second question's read is slow.
      if (reads > 1) await held;
      return {
        ok: true,
        value: { ok: true, task: { id: TASK.id, key: 'T-12', title: 'x', revision: 7 } },
      };
    },
    mutate: (name: string, _body: Answer) => {
      order.push(name);
      const reply = { answered: true, messageId: crypto.randomUUID(), body: 'Noted.' };
      return Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION }, reply },
      });
    },
  } as unknown as OperationsClient;
  return { client, order, release };
}

describe('the question’s task read and the model order', () => {
  it('a model chosen while the question’s task read is out is sent after the question, not before it', async () => {
    const { client, order, release } = recorder();
    askDrawer(taskAsk(TASK), GRANT);
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
    await page.type('[data-assistant="input"]', 'Where is this up to?');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    await settle();
    await page.type('[data-assistant="input"]', 'And what next?');
    await press(page, '[data-assistant="input"]', 'Enter');
    await settle();
    // After Enter, while the read is out, the person picks another model.
    await page.choose('[data-assistant="model"]', 'model-b');
    await settle();
    release();
    await settle();
    await settle();
    expect(order.filter((name) => name !== 'conversation.start')).toStrictEqual([
      'conversation.message',
      'conversation.set_model',
    ]);
  });
});
