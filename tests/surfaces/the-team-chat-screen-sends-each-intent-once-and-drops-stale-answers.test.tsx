// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team screen's chat writes, held and let go out of order by a stand-in
// server (`team-chat-held-stand-in.ts`): one operation id per intent, kept on
// a retry; no second command for an intent already in flight; and an answer
// that lands after a newer one, or after the business changed, is dropped.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { mount, type Mounted } from './mount.tsx';
import { DIRECT, GROUP } from './team-chat-stand-in.ts';
import { heldServer } from './team-chat-held-stand-in.ts';

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  });
};

async function until(say: string, check: () => boolean, deadline = Date.now() + 2000) {
  if (check()) return;
  if (Date.now() > deadline) throw new Error(`never happened: ${say}`);
  await settle();
  await until(say, check, deadline);
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const shown = (m: Mounted): string[] =>
  m.all('.tmc__conv .msg').map((el) => (el as HTMLElement).dataset['message'] ?? '');

async function team(api = heldServer()) {
  view = await mount(<TeamScreen client={api.client} grantKey="alpha:ana" />);
  const m = view;
  await until('the conversation open on Bo', () => shown(m).length > 0);
  return { api, m };
}

const commands = (api: ReturnType<typeof heldServer>, at: string) =>
  api.sent.filter((one) => one.at === at);

describe('the Team chat screen sends each intent once', () => {
  it('pressing Remove again while the first member change is in flight sends one change', async () => {
    const { api, m } = await team();
    await m.click(`[data-group="${GROUP}"]`);
    api.settings.holdCommands = true;
    await m.click('.tmc__remove');
    await settle();
    await m.click('.tmc__remove');
    await settle();
    expect(commands(api, '/chat/change_members')).toHaveLength(1);
  });

  it('clicking the open conversation again while its mark_read is in flight sends one mark_read', async () => {
    const { api, m } = await team();
    api.settings.holdCommands = true;
    await m.click('.tmc__conv .tmc__scroll');
    await settle();
    await m.click('.tmc__conv .tmc__scroll');
    await settle();
    expect(commands(api, '/chat/mark_read')).toHaveLength(1);
  });

  it('a Remove pressed again after its answer was lost presents the first attempt’s operation id', async () => {
    const { api, m } = await team();
    await m.click(`[data-group="${GROUP}"]`);
    api.settings.reply = 'lose';
    await m.click('.tmc__remove');
    await until('the lost answer said', () => m.find('[role="alert"]') !== null);
    api.settings.reply = 'answer';
    await m.click('.tmc__remove');
    await until('the second press sent', () => commands(api, '/chat/change_members').length === 2);
    const [first, again] = commands(api, '/chat/change_members').map((one) => one.body);
    expect(again?.['operationId']).toBe(first?.['operationId']);
  });
});

// eslint-disable-next-line max-lines-per-function -- the stale answers, one stand-in each
describe('the Team chat screen drops stale answers', () => {
  it('a group action’s refusal that lands after the business changed is not drawn for the new business', async () => {
    const { api, m } = await team();
    await m.click(`[data-group="${GROUP}"]`);
    api.settings.holdCommands = true;
    api.settings.reply = 'refuse';
    await m.click('.tmc__leave');
    await until('the leave in flight', () => api.heldCount() === 1);
    const bravo = heldServer('bravo');
    await m.render(<TeamScreen client={bravo.client} grantKey="bravo:ana" />);
    await until('the new business drawn', () => shown(m).length > 0);
    api.letGo();
    await settle();
    await settle();
    expect(m.find('[role="alert"]')?.textContent ?? null).toBeNull();
  });

  it('an older chat.conversations answer landing after a newer one does not bring back management it withdrew', async () => {
    const { api, m } = await team();
    await m.click(`[data-group="${GROUP}"]`);
    expect(m.find('.tmc__rename')).not.toBeNull();
    api.settings.holdLists = true;
    api.signal('resync', 'board');
    await until('the older list asked', () => api.heldCount() === 1);
    const group = api.chats[GROUP];
    if (group !== undefined) group.view = { ...group.view, canManage: false };
    api.signal('resync', 'board');
    await until('the newer list asked', () => api.heldCount() === 2);
    api.letGo(1);
    await until('management withdrawn', () => m.find('.tmc__rename') === null);
    api.letGo(0);
    await settle();
    await settle();
    expect(m.find('.tmc__rename')).toBeNull();
  });

  it('once the mark_read of a tied message is answered the screen counts it read', async () => {
    const api = heldServer();
    const direct = api.chats[DIRECT];
    if (direct === undefined) throw new Error('direct fixture absent');
    // Two messages in one millisecond, the marker after the first (`...001Z`).
    direct.view = { ...direct.view, lastRead: '2026-10-01T10:00:00.000001Z', unread: 1 };
    for (const message of direct.messages) message.at = '2026-10-01T10:00:00.000002Z';
    const { m } = await team(api);
    await m.click('.tmc__conv .tmc__scroll');
    await until('the mark_read sent', () => commands(api, '/chat/mark_read').length === 1);
    await settle();
    await settle();
    expect(m.find('[data-person="p-bo"] .cbadge')?.textContent ?? null).toBeNull();
  });
});
