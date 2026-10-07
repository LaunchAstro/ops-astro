// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A drafted question and its citation belong to the conversation they were
// drafted in. An ask on a client's task opens a tab whose words wait on a
// local model; selecting another tab, or closing the asked one, must leave
// none of those words in the field, and nothing of them can be sent as an
// unscoped conversation. The operations client is a recorder at the network
// boundary.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { askDrawer, newAttemptAsk } from '../../apps/web/src/assistant/asks.ts';
import { ask, initial, select, takeOut } from '../../apps/web/src/assistant/chats.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CANARY = 'CANARY-draft-5e1c';
const TASK = {
  id: '88888888-8888-4888-8888-888888888888',
  title: `${CANARY} brief`,
  clientId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function recorder(): { readonly client: OperationsClient; readonly sent: unknown[] } {
  const sent: unknown[] = [];
  const client = {
    read: () => Promise.resolve({ unavailable: true, because: 'not asked here' }),
    mutate: (name: string, body: unknown) => {
      sent.push({ name, body });
      return Promise.resolve({
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: 'c-1' } },
      });
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

const field = (page: Mounted): string =>
  (page.find('[data-assistant="input"]') as HTMLInputElement | null)?.value ?? '';

/** The drawer on an agency page, asked to plan a new attempt at a client's task. */
async function asked(): Promise<{ readonly page: Mounted; readonly sent: unknown[] }> {
  const { client, sent } = recorder();
  const page = track(
    await mount(
      <AssistantView
        grantKey="alpha:ada"
        client={client}
        route="agency:projects-board"
        here="/projects"
        entry={null}
      />,
    ),
  );
  askDrawer(newAttemptAsk(TASK), 'alpha:ada');
  await settle();
  expect(field(page)).toContain(CANARY);
  // The client's words wait on a local model: nothing leaves.
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
  expect(sent).toStrictEqual([]);
  return { page, sent };
}

/** The unscoped tab now selected holds none of the client's words and sends none. */
async function nothingCarried(page: Mounted, sent: unknown[]): Promise<void> {
  expect(page.find('[data-chat="chat-1"]')?.getAttribute('aria-selected')).toBe('true');
  expect(field(page)).toBe('');
  expect(page.find('[data-assistant="citation"]')).toBeNull();
  await press(page, '[data-assistant="input"]', 'Enter');
  await page.click('[data-assistant="send"]');
  await settle();
  expect(sent).toStrictEqual([]);
  expect(JSON.stringify(sent)).not.toContain(CANARY);
}

describe('a drafted question stays with its conversation', () => {
  it('selecting the unscoped tab after a client ask carries none of its words, and none can be sent', async () => {
    const { page, sent } = await asked();
    await page.click('[data-chat="chat-1"]');
    await nothingCarried(page, sent);
  });

  it('closing the asked tab carries none of its words into the tab left selected', async () => {
    const { page, sent } = await asked();
    await page.click('[data-chat-close="chat-2"]');
    await nothingCarried(page, sent);
  });

  it('the moves: another tab selected clears the draft and citation; the same tab keeps them', () => {
    const drafted = ask(initial(), newAttemptAsk(TASK));
    expect(drafted.draft).toContain(CANARY);
    expect(select(drafted, drafted.selected)).toBe(drafted);
    for (const moved of [select(drafted, 'chat-1'), takeOut(drafted, drafted.selected)]) {
      expect(moved.selected).toBe('chat-1');
      expect(moved.draft).toBe('');
      expect(moved.citation).toBeNull();
      expect(moved.scope).toStrictEqual({ client: null, task: null });
    }
  });
});
