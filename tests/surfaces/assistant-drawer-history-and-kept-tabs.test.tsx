// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33/34 and C36, the drawer's history: the person's own past
// conversations listed from `conversation.list` and reopened as a tab from
// `conversation.read`; started tabs kept for the session across a reload and
// read again when they come back, so a reply whose response was lost is picked
// up; and an "answering" line while a question is out. The client is a stand-in
// at the operations boundary: who may list or read which conversation is
// proven against Postgres in tests/api/aw-03-isolation and c36-isolation.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the drawer's own tests do */

import { afterEach, describe, expect, it } from 'vitest';
import { AssistantView } from '../../apps/web/src/views/assistant.tsx';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle, type Mounted } from './mount.tsx';
import { track, unmountAll } from './mp-7-11-drawer-fixtures.tsx';

afterEach(unmountAll);

const ONE = '11111111-1111-4111-8111-111111111111';
const TWO = '22222222-2222-4222-8222-222222222222';
const MADE = '33333333-3333-4333-8333-333333333333';

interface Call {
  readonly kind: 'read' | 'write';
  readonly name: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const message = (id: string, role: 'person' | 'agent', body: string) => ({
  id,
  role,
  body,
  createdAt: '2026-10-06T10:00:00.000Z',
});

/** The server's conversations: their titles and stored messages, read as the case left them. */
type Stored = Record<string, { title: string; messages: ReturnType<typeof message>[] }>;

function serving(stored: Stored, mutate?: (call: Omit<Call, 'kind'>) => Promise<unknown>) {
  const calls: Call[] = [];
  const read = (name: string, body: Readonly<Record<string, unknown>>) => {
    calls.push({ kind: 'read', name, body });
    if (name === 'conversation.list') {
      const conversations = Object.entries(stored).map(([id, one]) => ({
        id,
        address: `/agent/${id}`,
        title: one.title,
        lastActivityAt: '2026-10-06T10:00:00.000Z',
        bodyPurged: false,
      }));
      return Promise.resolve({ ok: true, value: { ok: true, conversations } });
    }
    const id = String(body['conversationId']);
    const one = stored[id];
    if (name !== 'conversation.read' || one === undefined) {
      return Promise.resolve({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] });
    }
    const conversation = {
      id,
      address: `/agent/${id}`,
      title: one.title,
      subject: null,
      scope: null,
      page: null,
      createdAt: '2026-10-06T10:00:00.000Z',
      lastActivityAt: '2026-10-06T10:00:00.000Z',
      bodyPurgedAt: null,
    };
    return Promise.resolve({
      ok: true,
      value: { ok: true, conversation, messages: one.messages, wrapUp: null },
    });
  };
  const client = {
    read,
    mutate: (name: string, body: Readonly<Record<string, unknown>>) => {
      calls.push({ kind: 'write', name, body });
      return mutate === undefined
        ? Promise.resolve({ unavailable: true, because: 'n/a' })
        : mutate({ name, body });
    },
  } as unknown as OperationsClient;
  return { client, calls };
}

async function drawerFor(client: OperationsClient, grantKey = 'alpha:ana'): Promise<Mounted> {
  const page = track(
    await mount(
      <AssistantView
        client={client}
        route="agency:settings"
        here="/settings"
        entry={null}
        grantKey={grantKey}
      />,
    ),
  );
  await settle();
  return page;
}

const tabTitles = (page: Mounted): (string | null)[] =>
  page.all('[data-chat]').map((tab) => tab.textContent);

const bodies = (page: Mounted): (string | null)[] =>
  page
    .all('[data-message-role]')
    .map((line) => `${line.getAttribute('data-message-role')}: ${line.textContent}`);

const STORED: Stored = {
  [ONE]: {
    title: 'Pacing question',
    messages: [
      message('m1', 'person', 'Is pacing on track?'),
      message('m2', 'agent', 'Yes, 4% under.'),
    ],
  },
  [TWO]: { title: 'Older chat', messages: [message('m3', 'person', 'Hello')] },
};

// eslint-disable-next-line max-lines-per-function -- one drawer, its history and kept tabs
describe('MP-7-11 CS-7.33 drawer history', () => {
  it('CS-7.33 lists my past conversations and reopens one as a tab with its transcript', async () => {
    const { client, calls } = serving(STORED);
    const page = await drawerFor(client);
    await page.click('[data-assistant="history"]');
    await settle();
    expect(calls.filter((call) => call.name === 'conversation.list')).toHaveLength(1);
    expect(page.all('[data-past]').map((row) => row.getAttribute('data-past'))).toStrictEqual([
      ONE,
      TWO,
    ]);
    await page.click(`[data-past="${ONE}"]`);
    await settle();
    expect(calls.filter((call) => call.name === 'conversation.read')).toStrictEqual([
      { kind: 'read', name: 'conversation.read', body: { conversationId: ONE } },
    ]);
    expect(tabTitles(page).at(-1)).toContain('Pacing question');
    expect(bodies(page)).toStrictEqual(['user: Is pacing on track?', 'ai: Yes, 4% under.']);
    expect(page.find('[data-assistant="address"]')?.getAttribute('href')).toBe(`/agent/${ONE}`);
    // Reading the list or a conversation writes nothing.
    expect(calls.filter((call) => call.kind === 'write')).toStrictEqual([]);
  });

  it('CS-7.33 reopening a conversation already open selects its tab, never a second one', async () => {
    const { client } = serving(STORED);
    const page = await drawerFor(client);
    const reopen = async (): Promise<void> => {
      await page.click('[data-assistant="history"]');
      await settle();
      await page.click(`[data-past="${ONE}"]`);
      await settle();
    };
    await reopen();
    await reopen();
    expect(tabTitles(page).filter((title) => title?.includes('Pacing question'))).toHaveLength(1);
  });

  it('C36 a started tab is kept for the session across a reload, its transcript read again', async () => {
    const stored: Stored = {};
    const { client } = serving(stored, ({ name, body }) => {
      if (name !== 'conversation.start') {
        return Promise.resolve({ unavailable: true, because: 'n/a' });
      }
      stored[MADE] = {
        title: 'Chat 1',
        messages: [
          message('m1', 'person', String(body['body'])),
          message('m2', 'agent', 'Answered.'),
        ],
      };
      return Promise.resolve({
        ok: true,
        value: {
          recordId: MADE,
          revision: 1,
          detail: { conversationId: MADE },
          reply: { answered: true, body: 'Answered.' },
        },
      });
    });
    const first = await drawerFor(client);
    await first.click('.aip__chip');
    await settle();
    await first.unmount();
    const reloaded = await drawerFor(client);
    expect(tabTitles(reloaded)).toStrictEqual(['Chat 1']);
    expect(bodies(reloaded).at(-1)).toBe('ai: Answered.');
    expect(reloaded.find('[data-assistant="address"]')?.getAttribute('href')).toBe(
      `/agent/${MADE}`,
    );
  });

  it('C36 kept tabs are the session’s own: another sign-in in the tab gets none of them', async () => {
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:alpha:ana',
      JSON.stringify({ selected: ONE, tabs: [{ conversationId: ONE, title: 'Pacing question' }] }),
    );
    const { client, calls } = serving(STORED);
    const other = await drawerFor(client, 'alpha:bo');
    expect(tabTitles(other)).toStrictEqual(['Chat 1']);
    expect(calls.filter((call) => call.name === 'conversation.read')).toStrictEqual([]);
  });

  it('C36 a stored value of any other shape brings back nothing and reads nothing', async () => {
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:alpha:ana',
      JSON.stringify({ selected: ONE, tabs: [{ conversationId: '../account', title: 'x' }] }),
    );
    const { client, calls } = serving(STORED);
    const page = await drawerFor(client);
    expect(tabTitles(page)).toStrictEqual(['Chat 1']);
    expect(calls.filter((call) => call.name !== 'conversation.allowance')).toStrictEqual([]);
  });

  it('MP-7-11 an answering line shows while a question is out, and goes when its answer lands', async () => {
    let answer: (() => void) | undefined;
    const { client } = serving(
      {},
      () =>
        new Promise((resolve) => {
          answer = () =>
            resolve({
              ok: true,
              value: { recordId: MADE, revision: 1, detail: { conversationId: MADE } },
            });
        }),
    );
    const page = await drawerFor(client);
    await page.click('.aip__chip');
    await settle();
    expect(page.find('[data-assistant="answering"]')?.textContent).toContain('Answering');
    answer?.();
    await settle();
    await settle();
    expect(page.find('[data-assistant="answering"]')).toBeNull();
  });

  it('MP-7-11 a reply whose response was lost is picked up when the tab is opened again', async () => {
    const stored: Stored = {
      [ONE]: { title: 'Pacing question', messages: [...STORED[ONE]!.messages] },
    };
    const { client } = serving(stored, ({ name, body }) => {
      if (name !== 'conversation.message') {
        return Promise.resolve({ unavailable: true, because: 'n/a' });
      }
      // The server keeps the question and answers it; the response never arrives.
      stored[ONE]!.messages.push(
        message('m3', 'person', String(body['body'])),
        message('m4', 'agent', 'Late answer.'),
      );
      return Promise.resolve({ unavailable: true, because: 'The connection dropped.' });
    });
    const first = await drawerFor(client);
    await first.click('[data-assistant="history"]');
    await settle();
    await first.click(`[data-past="${ONE}"]`);
    await settle();
    await first.click('.aip__chip');
    await settle();
    expect(bodies(first)).not.toContain('ai: Late answer.');
    await first.unmount();
    const again = await drawerFor(client);
    expect(bodies(again).at(-1)).toBe('ai: Late answer.');
  });
});
