// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A dock count drops only an answer older than the one drawn: while a newer
// read is still out, an earlier answer lands, so a burst of board events
// cannot keep the bell or the Team chip from drawing.

import { act, type ReactElement } from 'react';
import { expect, it } from 'vitest';
import {
  nudgeTeamUnread,
  useOwedCount,
  useTeamUnread,
} from '../../apps/web/src/data/dock-counts.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, settle } from './mount.tsx';

const session = { businessKey: 'alpha', email: 'ana@example.test' };

const list = (unread: number): Response =>
  Response.json({
    ok: true,
    conversations: [
      {
        conversationId: '11111111-1111-4111-8111-111111111111',
        kind: 'direct',
        name: null,
        members: ['p-me', 'p-bo'],
        joinedAt: '2026-10-01T09:00:00.000Z',
        lastRead: null,
        lastMessageAt: '2026-10-01T10:00:00.000Z',
        unread,
      },
    ],
  });

function held(ends: string) {
  const pending: ((answer: Response) => void)[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url) => {
      if (String(url).endsWith(ends))
        return await new Promise<Response>((resolve) => {
          pending.push(resolve);
        });
      return Response.json({ error: 'down' }, { status: 503 });
    },
  });
  return { pending, client };
}

it('an inbox count answers while a newer count is still out and the bell draws it', async () => {
  const { pending, client } = held('/inbox/count');
  function Bell(): ReactElement {
    return <output>{useOwedCount(client, session, true) ?? 'none'}</output>;
  }
  const view = await mount(<Bell />);
  try {
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await settle();
    });
    expect(pending).toHaveLength(2);
    await act(() => {
      pending[0]?.(Response.json({ owed: 3 }));
    });
    await settle();
    expect(view.text()).toBe('3');
    await act(() => {
      pending[1]?.(Response.json({ owed: 4 }));
    });
    await settle();
    expect(view.text()).toBe('4');
  } finally {
    await view.unmount();
    await settle();
  }
});

it('a Team unread answers while a newer read is still out and the chip draws it', async () => {
  const { pending, client } = held('/chat/conversations');
  function Chip(): ReactElement {
    return <output>{useTeamUnread(client, session, true) ?? 'none'}</output>;
  }
  const view = await mount(<Chip />);
  try {
    await act(() => {
      nudgeTeamUnread(client);
    });
    expect(pending).toHaveLength(2);
    await act(() => {
      pending[0]?.(list(2));
    });
    await settle();
    expect(view.text()).toBe('2');
    await act(() => {
      pending[1]?.(list(1));
    });
    await settle();
    expect(view.text()).toBe('1');
  } finally {
    await view.unmount();
    await settle();
  }
});
