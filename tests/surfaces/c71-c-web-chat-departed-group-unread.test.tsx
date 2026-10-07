// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A group the reader was removed from keeps no read marker for them (the
// server refuses one), so its unread could never clear. It adds nothing to
// the Team chip, the panel never opens on it, and it draws no unread badge.

import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import { useTeamUnread } from '../../apps/web/src/data/dock-counts.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TeamScreen } from '../../apps/web/src/screens/Team.tsx';
import { mount, settle } from './mount.tsx';

const ID = '11111111-1111-4111-8111-111111111111';
const AT = '2026-10-01T10:00:00.000Z';
const group = {
  conversationId: ID,
  kind: 'group',
  name: 'Shoot crew',
  members: ['p-me', 'p-bo'],
  joinedAt: '2026-10-01T09:00:00.000Z',
  lastRead: null,
  lastMessageAt: AT,
  unread: 1,
};
const removed = { ...group, name: null, members: [], joinedAt: null };

function server(view: { left: boolean }) {
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const fetch: typeof globalThis.fetch = async (input) => {
    const at = String(input);
    await Promise.resolve();
    if (at.includes('/live?'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    if (at.endsWith('/team/list'))
      return Response.json({
        ok: true,
        you: 'p-me',
        people: [
          { personId: 'p-me', name: 'Mia Lane', availability: null },
          { personId: 'p-bo', name: 'Bo Reyes', availability: null },
        ],
      });
    if (at.endsWith('/chat/conversations'))
      return Response.json({ ok: true, conversations: [view.left ? removed : group] });
    if (at.endsWith('/chat/messages'))
      return Response.json({
        ok: true,
        conversationId: ID,
        lastRead: null,
        messages: [{ id: 'm1', authorId: 'p-bo', author: 'Bo Reyes', at: AT, body: 'rushes up' }],
      });
    throw new Error(`unexpected ${at}`);
  };
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    signal(): void {
      stream?.enqueue(new TextEncoder().encode('event: conversation\ndata: board\n\n'));
    },
  };
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    // eslint-disable-next-line no-await-in-loop -- each answer lands before its next effect
    await settle();
  }
}

it('a removal with unread leaves the Team chip at 0', async () => {
  const view = { left: false };
  const api = server(view);
  const session = { businessKey: 'alpha', email: 'mia@example.test' };
  function Chip(): ReactElement {
    return <output>{useTeamUnread(api.client, session, true) ?? 'none'}</output>;
  }
  const page = await mount(<Chip />);
  await flush();
  expect(page.text()).toBe('1');
  view.left = true;
  await act(() => {
    api.signal();
  });
  await flush();
  expect(page.text()).toBe('0');
});

it('the Team panel neither opens on nor badges a group the reader was removed from', async () => {
  const api = server({ left: true });
  const page = await mount(<TeamScreen client={api.client} grantKey="alpha:mia" />);
  await flush();
  expect(page.find(`[data-group="${ID}"]`)).not.toBeNull();
  expect(page.find('.tmc__glist .cbadge')).toBeNull();
  expect(page.find('.tmc__conv [data-message="m1"]')).toBeNull();
});
