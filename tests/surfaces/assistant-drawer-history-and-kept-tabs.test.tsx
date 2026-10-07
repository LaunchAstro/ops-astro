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
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import { settle } from './mount.tsx';
import { unmountAll } from './mp-7-11-drawer-fixtures.tsx';
import {
  bodies,
  drawerFor,
  message,
  serving,
  tabTitles,
  MADE,
  ONE,
  STORED,
  TWO,
  type Stored,
} from './drawer-history-support.tsx';

afterEach(unmountAll);

function heldResponse() {
  let release: ((response: Response) => void) | undefined;
  const sent = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { sent, release: (response: Response) => release?.(response) };
}

const historyResponse = (ids: readonly string[]): Response =>
  Response.json({
    ok: true,
    conversations: ids.map((id) => ({
      id,
      address: `/agent/${id}`,
      title: id === ONE ? 'First conversation' : 'New conversation',
      lastActivityAt: '2026-10-06T10:00:00.000Z',
      bodyPurged: false,
    })),
  });

// eslint-disable-next-line max-lines-per-function -- one drawer, its history and kept tabs
describe('MP-7-11 CS-7.33 drawer history', () => {
  it.each(['success', 'unavailable', 'refusal'])(
    'R10 the latest shown history survives an older %s response',
    async (older) => {
      const first = heldResponse();
      const second = heldResponse();
      let lists = 0;
      const client = new OperationsClient({
        origin: '',
        businessKey: 'alpha',
        signedIn: true,
        fetch: (url) => {
          if (!String(url).endsWith(pathOf('conversation.list'))) {
            return Promise.resolve(Response.json({}, { status: 503 }));
          }
          lists += 1;
          return lists === 1 ? first.sent : second.sent;
        },
      });
      const page = await drawerFor(client);
      await page.click('[data-assistant="history"]');
      await page.click('[data-assistant="history"]');
      await page.click('[data-assistant="history"]');
      expect(lists).toBe(2);
      second.release(historyResponse([TWO, ONE]));
      await settle();
      await settle();
      expect(page.all('[data-past]').map((row) => row.getAttribute('data-past'))).toStrictEqual([
        TWO,
        ONE,
      ]);
      first.release(
        older === 'success'
          ? historyResponse([ONE])
          : older === 'refusal'
            ? Response.json(
                { refused: true, code: 'NOT_FOUND', names: [], fixes: ['Earlier list refused.'] },
                { status: 403 },
              )
            : Response.json({}, { status: 503 }),
      );
      await settle();
      await settle();
      expect(page.all('[data-past]').map((row) => row.getAttribute('data-past'))).toStrictEqual([
        TWO,
        ONE,
      ]);
      expect(page.find('[data-assistant="history"]')?.getAttribute('aria-expanded')).toBe('true');
    },
  );

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
    // Only the opaque id is kept: no title or words of the conversation stay in the tab's storage.
    expect(
      JSON.parse(sessionStorage.getItem('ops-astro:drawer-tabs:alpha:ana') ?? 'null'),
    ).toStrictEqual({
      selected: MADE,
      tabs: [MADE],
    });
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
      JSON.stringify({ selected: ONE, tabs: [ONE] }),
    );
    const { client, calls } = serving(STORED);
    const other = await drawerFor(client, 'alpha:bo');
    expect(tabTitles(other)).toStrictEqual(['Chat 1']);
    expect(calls.filter((call) => call.name === 'conversation.read')).toStrictEqual([]);
  });

  it('C36 a stored value of any other shape brings back nothing and reads nothing', async () => {
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:alpha:ana',
      JSON.stringify({ selected: ONE, tabs: ['../account'] }),
    );
    const { client, calls } = serving(STORED);
    const page = await drawerFor(client);
    expect(tabTitles(page)).toStrictEqual(['Chat 1']);
    // The empty drawer asks which models it may offer, naming no conversation (CS-7.30).
    const offer = calls.filter((call) => call.name === 'conversation.models');
    expect(offer).toStrictEqual([{ kind: 'read', name: 'conversation.models', body: {} }]);
    expect(
      calls.filter((call) => call.name !== 'conversation.allowance' && !offer.includes(call)),
    ).toStrictEqual([]);
    expect(calls.filter((call) => JSON.stringify(call.body).includes('../account'))).toStrictEqual(
      [],
    );
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
