// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects board matches the mockup: it draws no inbox. The inbox is the
// dock's Notifications panel and `/inbox/` (MP-7-3), one screen, reading the
// same `inbox.read` and `inbox.count`; taking the panel off the board loses
// nothing.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { InboxScreen } from '../../apps/web/src/screens/Inbox.tsx';
import type { InboxEntry } from '../../packages/core-wire/src/index.ts';
import { mount, settle } from './mount.tsx';

const entry = (id: string, reason: InboxEntry['reason']): InboxEntry => ({
  id,
  reason,
  workState: 'open',
  access: 'readable',
  owed: true,
  counted: true,
  raisedAt: '2026-10-01T00:00:00.000Z',
  closedAt: null,
  seenAt: null,
  lastDelivery: null,
  subjectRecordId: `task-${id}`,
  task: { key: `T-${id}`, title: `Task ${id}` },
  closedBy: null,
});

it('the board draws no inbox, and the Notifications panel still lists the same items', async () => {
  const inbox = [entry('a', 'mention'), entry('b', 'assignment')];
  const called: string[] = [];
  const fetch = ((url: string | URL) => {
    const path = String(url);
    called.push(path);
    if (path.endsWith('/inbox/read')) return Promise.resolve(Response.json({ ok: true, inbox }));
    if (path.endsWith('/inbox/count')) return Promise.resolve(Response.json({ ok: true, owed: 2 }));
    return Promise.resolve(Response.json({ ok: true, tasks: [] }));
  }) as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });

  const board = await mount(<Projects client={client} grantKey="alpha:mia" navigate={() => {}} />);
  await settle();
  expect(board.find('#inbox-heading')).toBeNull();
  expect(board.all('[data-inbox-item]')).toHaveLength(0);
  expect(called.filter((path) => /\/inbox\//u.test(path))).toEqual([]);
  await board.unmount();

  const panel = await mount(
    <InboxScreen client={client} grantKey="alpha:mia" navigate={() => {}} />,
  );
  await settle();
  expect(panel.all('a.nt__row').map((row) => row.getAttribute('href'))).toEqual(
    expect.arrayContaining(['/task/T-a', '/task/T-b']),
  );
  expect(panel.all('a.nt__row')).toHaveLength(2);
  expect(panel.find('.nt__sum b')?.textContent).toBe('2');
  await panel.unmount();
});
