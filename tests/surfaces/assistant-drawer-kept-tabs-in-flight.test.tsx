// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33 and C36, the drawer's kept and reopened tabs against what is
// still in flight: a restored tab's read racing a new question, a reopen racing
// its own tab's start, and a restored tab's rename reaching its conversation.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the drawer's own tests do */

import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import { settle } from './mount.tsx';
import { doubleClick, press, unmountAll } from './mp-7-11-drawer-fixtures.tsx';
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

// eslint-disable-next-line max-lines-per-function -- one drawer, each race named
describe('MP-7-11 kept and reopened tabs against work in flight', () => {
  it.each([
    {
      body: {
        refused: true,
        code: 'NOT_FOUND',
        names: [],
        fixes: ['Your access to this conversation was removed.'],
      },
      status: 403,
      reason: 'Your access to this conversation was removed.',
    },
    {
      body: { refused: true, code: 'NOT_FOUND', names: [], fixes: [] },
      status: 403,
      reason: 'NOT_FOUND',
    },
    { body: {}, status: 503, reason: 'The API answered 503.' },
  ])(
    'a failed history reopen shows $reason and keeps its rows usable for retry',
    async ({ body, status, reason }) => {
      const refused = heldResponse();
      const retry = heldResponse();
      let reads = 0;
      const client = new OperationsClient({
        origin: '',
        businessKey: 'alpha',
        signedIn: true,
        fetch: (url) => {
          const path = String(url);
          if (path.endsWith(pathOf('conversation.list')))
            return Promise.resolve(historyResponse([ONE, TWO]));
          if (path.endsWith(pathOf('conversation.read')))
            return ++reads === 1 ? refused.sent : retry.sent;
          return Promise.resolve(Response.json({}, { status: 503 }));
        },
      });
      const page = await drawerFor(client);
      await page.click('[data-assistant="history"]');
      await settle();
      await page.click(`[data-past="${ONE}"]`);
      refused.release(Response.json(body, { status }));
      await settle();
      await settle();
      expect(page.find('[data-assistant="past"]')?.textContent ?? '').toContain(reason);
      expect(page.find('[data-assistant="history"]')?.getAttribute('aria-expanded')).toBe('true');
      expect(page.all('[data-past]').map((row) => row.getAttribute('data-past'))).toStrictEqual([
        ONE,
        TWO,
      ]);
      expect(tabTitles(page)).toStrictEqual(['Chat 1']);
      expect(bodies(page)).toStrictEqual([]);
      await page.click(`[data-past="${ONE}"]`);
      await settle();
      expect(page.text()).not.toContain(reason);
      retry.release(
        Response.json({
          ok: true,
          conversation: { id: ONE, title: 'Pacing question' },
          messages: STORED[ONE]!.messages,
        }),
      );
      await settle();
      await settle();
      expect(reads).toBe(2);
      expect(page.find('[data-assistant="past"]')).toBeNull();
      expect(page.find('[data-assistant="history"]')?.getAttribute('aria-expanded')).toBe('false');
      expect(tabTitles(page).at(-1)).toBe('Pacing question');
      expect(bodies(page)).toStrictEqual(['user: Is pacing on track?', 'ai: Yes, 4% under.']);
    },
  );

  it('C36 a question asked in a restored tab before its read lands follows the transcript, never overwritten', async () => {
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:alpha:ana',
      JSON.stringify({ selected: ONE, tabs: [ONE] }),
    );
    let land: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      land = resolve;
    });
    const { client } = serving(
      STORED,
      () =>
        Promise.resolve({
          ok: true,
          value: { recordId: ONE, revision: 2, reply: { answered: true, body: 'Still on track.' } },
        }),
      gate,
    );
    const page = await drawerFor(client);
    await page.click('.aip__chip');
    land?.();
    await settle();
    await settle();
    const question = page.find('.aip__chip')?.textContent ?? '';
    expect(bodies(page).slice(0, 2)).toStrictEqual([
      'user: Is pacing on track?',
      'ai: Yes, 4% under.',
    ]);
    expect(bodies(page).slice(2)).toStrictEqual([`user: ${question}`, 'ai: Still on track.']);
  });

  it('CS-7.33 a conversation reopened from the history while its own tab is still starting stays one tab', async () => {
    const stored: Stored = {
      [MADE]: { title: 'Chat 1', messages: [message('m1', 'person', 'Hi')] },
    };
    let finish: (() => void) | undefined;
    const { client } = serving(stored, ({ name }) =>
      name === 'conversation.start'
        ? new Promise((resolve) => {
            finish = () =>
              resolve({
                ok: true,
                value: { recordId: MADE, revision: 1, detail: { conversationId: MADE } },
              });
          })
        : Promise.resolve({ unavailable: true, because: 'n/a' }),
    );
    const page = await drawerFor(client);
    await page.click('.aip__chip');
    await page.click('[data-assistant="history"]');
    await settle();
    await page.click(`[data-past="${MADE}"]`);
    await settle();
    finish?.();
    await settle();
    await settle();
    expect(tabTitles(page)).toHaveLength(1);
  });

  it('C36 renaming a restored tab renames its conversation', async () => {
    sessionStorage.setItem(
      'ops-astro:drawer-tabs:alpha:ana',
      JSON.stringify({ selected: ONE, tabs: [ONE] }),
    );
    const { client, calls } = serving(STORED, () =>
      Promise.resolve({ ok: true, value: { recordId: ONE, revision: 2 } }),
    );
    const page = await drawerFor(client);
    const key = page.find('[data-chat]')?.getAttribute('data-chat') ?? '';
    await doubleClick(page, `[data-chat="${key}"]`);
    await page.type(`[data-chat-rename="${key}"]`, 'Pacing, renamed');
    await press(page, `[data-chat-rename="${key}"]`, 'Enter');
    await settle();
    expect(calls.filter((call) => call.kind === 'write')).toStrictEqual([
      {
        kind: 'write',
        name: 'conversation.rename',
        body: { conversationId: ONE, title: 'Pacing, renamed' },
      },
    ]);
  });

  it('R08 closing the starting tab keeps its reopened conversation selected when the start lands', async () => {
    const stored: Stored = {
      [MADE]: { title: 'Reopened conversation', messages: [message('m1', 'person', 'Hi')] },
    };
    let finish: (() => void) | undefined;
    const { client } = serving(
      stored,
      () =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              value: { recordId: MADE, revision: 1, detail: { conversationId: MADE } },
            });
        }),
    );
    const page = await drawerFor(client);
    const original = page.find('[data-chat]')?.getAttribute('data-chat');
    await page.click('.aip__chip');
    expect(finish).toBeTypeOf('function');
    await page.click('[data-assistant="history"]');
    await settle();
    await page.click(`[data-past="${MADE}"]`);
    await settle();
    const reopenedKey = page.find('[data-chat][aria-selected="true"]')?.getAttribute('data-chat');
    expect(reopenedKey).toBeTruthy();
    expect(reopenedKey).not.toBe(original);
    await page.click(`[data-chat-close="${original}"]`);
    finish?.();
    await settle();
    await settle();
    expect(page.find('[data-chat][aria-selected="true"]')?.getAttribute('data-chat')).toBe(
      reopenedKey,
    );
    expect(tabTitles(page)).toStrictEqual(['Reopened conversation']);
    expect(bodies(page)).toStrictEqual(['user: Hi']);
    expect(page.find('[data-assistant="address"]')?.getAttribute('href')).toBe(`/agent/${MADE}`);
    expect(page.find('[data-assistant="answering"]')).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem('ops-astro:drawer-tabs:alpha:ana') ?? 'null'),
    ).toStrictEqual({
      selected: MADE,
      tabs: [MADE],
    });
  });
});
