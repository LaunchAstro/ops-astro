// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team screen's chat writes, held and let go out of order by a stand-in
// server (`team-chat-held-stand-in.ts`): an older list answer landing after a
// newer one is dropped, and a marker moved within one millisecond counts the
// message read. The command runner's in-flight, retry and business-switch
// gaps are #1490's.

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

// eslint-disable-next-line max-lines-per-function -- the stale answers, one stand-in each
describe('the Team chat screen drops stale answers', () => {
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
