// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom

import { afterEach, expect, it } from 'vitest';
import { askDrawer, taskAsk } from '../../apps/web/src/assistant/asks.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle } from '../surfaces/mount.tsx';
import { press, track, unmountAll } from '../surfaces/mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// eslint-disable-next-line max-lines-per-function -- Sol's proof, kept as written
it('Sol proof, criterion 1: changing model during the first question task read preserves the model chosen at Enter', async () => {
  const task = {
    id: '55555555-5555-4555-8555-555555555555',
    title: 'Synthetic brief',
    clientId: null,
  };
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const sent: { name: string; body: Readonly<Record<string, unknown>> }[] = [];
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    newOperationId: () => crypto.randomUUID(),
    read: async (name: string) => {
      if (name === 'conversation.models') {
        return { ok: true, value: { models: [{ id: 'model-a' }, { id: 'model-b' }] } };
      }
      if (name === 'task.read') {
        await held;
        return { ok: true, value: { task: { ...task, revision: 7 } } };
      }
      return { unavailable: true, because: 'Not used in this proof' };
    },
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      return Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId } },
      });
    },
  } as unknown as OperationsClient;
  askDrawer(taskAsk(task), 'sol-1524:model-proof');
  const page = track(
    await mount(
      <AssistantView
        grantKey="sol-1524:model-proof"
        client={client}
        route="agency:task-detail"
        here="/task/T-12"
        entry={null}
        onClose={() => {}}
      />,
    ),
  );
  await settle();
  await page.choose('[data-assistant="model"]', 'model-a');
  await settle();
  await page.type('[data-assistant="input"]', 'What comes next?');
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
  await page.choose('[data-assistant="model"]', 'model-b');
  await settle();
  release?.();
  await settle();
  await settle();
  expect(sent.map(({ name }) => name)).toEqual(['conversation.start', 'conversation.set_model']);
  expect(sent.find(({ name }) => name === 'conversation.start')?.body['model']).toBe('model-a');
  expect(sent.find(({ name }) => name === 'conversation.set_model')?.body['model']).toBe('model-b');
});
