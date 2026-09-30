// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// MP-7-11, the drawer on the real conversation commands. The operations client
// here is a recorder standing in for the network only: each test reads which
// command a press sent, with what, and in what order. The commands themselves
// are proven on the real routes in `tests/api/mp-7-11-tabs.test.ts` and
// AW-03's suites.
/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name */

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { EntryPoint } from '../../apps/web/src/assistant/entries.ts';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';
import { doubleClick, press, track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

interface Sent {
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

function recorder(
  refuse: string | null = null,
  held: Promise<void> = Promise.resolve(),
): {
  readonly client: OperationsClient;
  readonly sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = {
    mutate: async (name: string, body: Readonly<Record<string, unknown>>) => {
      sent.push({ name, body });
      // An answer the test holds back, so a second press lands while the
      // first is still in flight.
      await held;
      if (refuse !== null) {
        return {
          ok: false,
          refused: true,
          code: 'FIELD_VALUE_INVALID',
          names: ['body'],
          fixes: [refuse],
        };
      }
      return {
        ok: true,
        value: { recordId: '', revision: 0, detail: { conversationId: CONVERSATION } },
      };
    },
  } as unknown as OperationsClient;
  return { client, sent };
}

/** An answer held back until the test lets it go. */
function heldAnswer(): { readonly held: Promise<void>; readonly release: () => void } {
  const released: (() => void)[] = [];
  const held = new Promise<void>((resolve) => {
    released.push(resolve);
  });
  return {
    held,
    release: () => {
      for (const resolve of released) resolve();
    },
  };
}

async function view(options: { refuse?: string; entry?: EntryPoint; held?: Promise<void> } = {}) {
  const { client, sent } = recorder(options.refuse ?? null, options.held);
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={options.entry ?? null}
        onClose={() => {}}
      />,
    ),
  );
  return { page, sent };
}

async function ask(page: Awaited<ReturnType<typeof view>>['page'], text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

// eslint-disable-next-line max-lines-per-function -- each command the drawer sends, in order
describe('MP-7-11 records', () => {
  it('a first question starts the conversation and the next joins it', async () => {
    const { page, sent } = await view();
    await ask(page, 'What does this setting do?');
    await ask(page, 'And the next one?');
    expect(sent).toStrictEqual([
      {
        name: 'conversation.start',
        body: {
          body: 'What does this setting do?',
          title: 'Chat 1',
          subject: 'Settings',
          scope: null,
        },
      },
      {
        name: 'conversation.message',
        body: { conversationId: CONVERSATION, body: 'And the next one?' },
      },
    ]);
    expect(page.all('[data-message-role="user"]').map((m) => m.textContent)).toStrictEqual([
      'What does this setting do?',
      'And the next one?',
    ]);
  });

  it('a rename or a page before the first question is kept and sent once it starts', async () => {
    const { page, sent } = await view();
    await doubleClick(page, '[data-chat="chat-1"]');
    await page.type('[data-chat-rename="chat-1"]', 'Settings help');
    await press(page, '[data-chat-rename="chat-1"]', 'Enter');
    await page.click('[data-assistant="add-page"]');
    expect(sent).toStrictEqual([]);
    await ask(page, 'What is on this page?');
    expect(sent.map((call) => call.name)).toStrictEqual([
      'conversation.start',
      'conversation.set_scope',
    ]);
    expect(sent[0]?.body['title']).toBe('Settings help');
    expect(sent[1]?.body).toStrictEqual({
      conversationId: CONVERSATION,
      page: { address: '/settings', shows: 'Settings' },
    });
    // Once started, a rename and a page go to the conversation straight away.
    await doubleClick(page, '[data-chat="chat-1"]');
    await page.type('[data-chat-rename="chat-1"]', 'Renamed');
    await press(page, '[data-chat-rename="chat-1"]', 'Enter');
    await page.click('[data-assistant="add-page"]');
    await settle();
    expect(sent.slice(2)).toStrictEqual([
      { name: 'conversation.rename', body: { conversationId: CONVERSATION, title: 'Renamed' } },
      {
        name: 'conversation.set_scope',
        body: { conversationId: CONVERSATION, page: { address: '/settings', shows: 'Settings' } },
      },
    ]);
  });

  it('two quick questions start one conversation: the second waits for the start', async () => {
    const gate = heldAnswer();
    const { held } = gate;
    const { page, sent } = await view({ held });
    await page.type('[data-assistant="input"]', 'First');
    await press(page, '[data-assistant="input"]', 'Enter');
    await page.type('[data-assistant="input"]', 'Second');
    await press(page, '[data-assistant="input"]', 'Enter');
    expect(sent.map((call) => call.name)).toStrictEqual(['conversation.start']);
    gate.release();
    await settle();
    await settle();
    expect(sent.map((call) => call.name)).toStrictEqual([
      'conversation.start',
      'conversation.message',
    ]);
    expect(sent[1]?.body).toStrictEqual({ conversationId: CONVERSATION, body: 'Second' });
  });

  it('a refusal is shown as a failed reply in the server’s words', async () => {
    const { page } = await view({ refuse: 'Send the first message as body.' });
    await ask(page, 'Hello');
    expect(page.find('[data-message-role="failed"]')?.textContent).toContain(
      'Send the first message as body.',
    );
  });
});

describe('MP-7-11 egress off', () => {
  it('an ask about a client sends no command at all, and says why', async () => {
    const { page, sent } = await view({
      entry: {
        row: 'CL-M03',
        widget: { id: 'clients-row', label: 'Meridian Physio, Clients' },
        client: { id: 'c1', name: 'Meridian Physio' },
        question: 'How is Meridian going?',
      },
    });
    expect(page.all('[data-assistant="model"] option')).toHaveLength(0);
    expect(page.find('[data-assistant="local-model"]')?.textContent).toContain(
      'waits on a local model',
    );
    await press(page, '[data-assistant="input"]', 'Enter');
    await page.click('.aip__chip');
    await settle();
    expect(sent).toStrictEqual([]);
    expect(page.find('[data-assistant="not-sent"]')).not.toBeNull();
  });
});
