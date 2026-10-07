// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11 CS-7.33 and C36, the drawer's kept and reopened tabs against answers
// that land late: a reload after the tab's session was signed in again, a start
// landing after its conversation was reopened and asked in, and a restored
// tab's first read landing after a rename or after the tab was closed.

/* eslint-disable unicorn/prefer-dom-node-dataset -- each assertion reads its data- attribute by the DOM name, as the drawer's own tests do */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { settle, type Mounted } from './mount.tsx';
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
  type Stored,
} from './drawer-history-support.tsx';

afterEach(unmountAll);

const ANA = { businessKey: 'alpha', email: 'ana@example.test' };

/** `client`, with its first `conversation.read` answered as the server had it then, once `release` is called. */
function holdingFirstRead(client: OperationsClient) {
  let release: (() => void) | undefined;
  let first = true;
  const read = (name: string, body: Readonly<Record<string, unknown>>) => {
    const answer = (client.read as (n: string, b: unknown) => Promise<unknown>)(name, body);
    if (name !== 'conversation.read' || !first) return answer;
    first = false;
    return new Promise((resolve) => {
      release = () => {
        resolve(answer);
      };
    });
  };
  return { client: { ...client, read } as unknown as OperationsClient, release: () => release?.() };
}

const keep = (id: string): void => {
  sessionStorage.setItem(
    'ops-astro:drawer-tabs:alpha:ana',
    JSON.stringify({ selected: id, tabs: [id] }),
  );
};

async function ask(page: Mounted, text: string): Promise<void> {
  await page.type('[data-assistant="input"]', text);
  await press(page, '[data-assistant="input"]', 'Enter');
  await settle();
}

async function reopen(page: Mounted, id: string): Promise<void> {
  await page.click('[data-assistant="history"]');
  await settle();
  await page.click(`[data-past="${id}"]`);
  await settle();
}

const replying = (body: string) =>
  Promise.resolve({
    ok: true,
    value: { recordId: MADE, revision: 2, reply: { answered: true, body } },
  });

// eslint-disable-next-line max-lines-per-function -- one drawer, each late answer named
describe('MP-7-11 kept and reopened tabs against answers that land late', () => {
  it('C36 a started tab comes back after a reload in a session signed in again after a sign-out', async () => {
    const before = await import('../../apps/web/src/session/token.ts');
    const sessions = new before.SessionStore(sessionStorage);
    sessions.set(ANA);
    sessions.clear();
    sessions.set(ANA);
    const stored: Stored = {};
    const { client, calls } = serving(stored, ({ name, body }) => {
      if (name !== 'conversation.start')
        return Promise.resolve({ unavailable: true, because: 'n/a' });
      stored[MADE] = {
        title: 'Chat 1',
        messages: [
          message('m1', 'person', String(body['body'])),
          message('m2', 'agent', 'Answered.'),
        ],
      };
      return Promise.resolve({
        ok: true,
        value: { recordId: MADE, revision: 1, detail: { conversationId: MADE } },
      });
    });
    const first = await drawerFor(client, before.grantKeyOf(sessions.session));
    await first.click('.aip__chip');
    await settle();
    await first.unmount();
    // The reload: the page's modules start again; the tab's storage stays.
    vi.resetModules();
    const after = await import('../../apps/web/src/session/token.ts');
    const reloaded = new after.SessionStore(sessionStorage);
    const page = await drawerFor(client, after.grantKeyOf(reloaded.session));
    expect(calls.filter((call) => call.name === 'conversation.read')).toStrictEqual([
      { kind: 'read', name: 'conversation.read', body: { conversationId: MADE } },
    ]);
    expect(bodies(page).at(-1)).toBe('ai: Answered.');
  });

  it('CS-7.33 a question asked in a reopened tab stays once its own tab’s start lands', async () => {
    const stored: Stored = {
      [MADE]: { title: 'Chat 1', messages: [message('m1', 'person', 'First question?')] },
    };
    let finish: (() => void) | undefined;
    const { client } = serving(stored, ({ name }) => {
      if (name === 'conversation.message') return replying('Second answer.');
      if (name !== 'conversation.start')
        return Promise.resolve({ unavailable: true, because: 'n/a' });
      return new Promise((resolve) => {
        finish = () => {
          resolve({
            ok: true,
            value: {
              recordId: MADE,
              revision: 1,
              detail: { conversationId: MADE },
              reply: { answered: true, body: 'First answer.' },
            },
          });
        };
      });
    });
    const page = await drawerFor(client);
    await ask(page, 'First question?');
    await reopen(page, MADE);
    await ask(page, 'Second question?');
    finish?.();
    await settle();
    await settle();
    expect(tabTitles(page)).toHaveLength(1);
    expect(bodies(page)).toStrictEqual([
      'user: First question?',
      'ai: First answer.',
      'user: Second question?',
      'ai: Second answer.',
    ]);
  });

  it('C36 a restored tab renamed before its read lands keeps the new title', async () => {
    keep(ONE);
    const stored: Stored = { [ONE]: { title: 'Old', messages: [...STORED[ONE]!.messages] } };
    const base = serving(stored, ({ name, body }) => {
      if (name === 'conversation.rename') stored[ONE]!.title = String(body['title']);
      return Promise.resolve({ ok: true, value: { recordId: ONE, revision: 2 } });
    });
    const { client, release } = holdingFirstRead(base.client);
    const page = await drawerFor(client);
    const key = page.find('[data-chat]')?.getAttribute('data-chat') ?? '';
    await doubleClick(page, `[data-chat="${key}"]`);
    await page.type(`[data-chat-rename="${key}"]`, 'New');
    await press(page, `[data-chat-rename="${key}"]`, 'Enter');
    await settle();
    expect(base.calls.filter((call) => call.name === 'conversation.rename')).toHaveLength(1);
    release();
    await settle();
    await settle();
    expect(tabTitles(page)).toHaveLength(1);
    expect(tabTitles(page)[0]).toContain('New');
    expect(bodies(page)).toStrictEqual(['user: Is pacing on track?', 'ai: Yes, 4% under.']);
  });

  it('C36 a closed restored tab’s late read leaves its conversation’s reopened tab alone', async () => {
    keep(ONE);
    const stored: Stored = {
      [ONE]: { title: 'Pacing question', messages: [...STORED[ONE]!.messages] },
    };
    const base = serving(stored, ({ name }) =>
      name === 'conversation.message'
        ? replying('Still on track.')
        : Promise.resolve({ unavailable: true, because: 'n/a' }),
    );
    const { client, release } = holdingFirstRead(base.client);
    const page = await drawerFor(client);
    const key = page.find('[data-chat]')?.getAttribute('data-chat') ?? '';
    await page.click(`[data-chat-close="${key}"]`);
    await settle();
    await reopen(page, ONE);
    await ask(page, 'And next week?');
    release();
    await settle();
    await settle();
    expect(bodies(page)).toStrictEqual([
      'user: Is pacing on track?',
      'ai: Yes, 4% under.',
      'user: And next week?',
      'ai: Still on track.',
    ]);
  });
});
