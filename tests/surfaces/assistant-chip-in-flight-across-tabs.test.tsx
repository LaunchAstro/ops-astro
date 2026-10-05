// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
/* oxlint-disable consistent-function-scoping, prefer-dom-node-dataset, require-await -- Sol's proof, kept as written */

import { afterEach, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

// Sol OW-109.1 criterion 5, retitled by what it proves; its body is Sol's.
it('returning to a tab preserves its chip send in flight', async () => {
  const sent: { name: string; body: Readonly<Record<string, unknown>> }[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = {
    read: async () => ({ unavailable: true, because: 'not part of this proof' }),
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      await held;
      return {
        ok: true,
        value: {
          recordId: '',
          revision: 0,
          detail: { conversationId: '33333333-3333-4333-8333-333333333333' },
        },
      };
    },
  } as unknown as OperationsClient;
  const page = track(
    await mount(
      <AssistantView client={client} route="agency:settings" here="/settings" entry={null} />,
    ),
  );
  const original = page.find('[data-chat]')?.getAttribute('data-chat');
  const question = page.find('.aip__chip')?.textContent;
  expect(original).toBeTruthy();
  expect(question).toBeTruthy();
  try {
    await page.click('.aip__chip');
    await settle();
    expect(sent.map((call) => call.name)).toEqual(['conversation.start']);
    // Control: the existing guard works while this input stays mounted.
    await page.click('.aip__chip');
    await page.click('[data-assistant="new"]');
    await page.click(`[data-chat="${original}"]`);
    await page.click('.aip__chip');
  } finally {
    release();
    await settle();
    await settle();
  }
  expect(sent.map((call) => [call.name, call.body['body']])).toEqual([
    ['conversation.start', question],
  ]);
});
