// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3 on the application: `/inbox/` is a route of its own, drawn from
// INB-1's `inbox.read` and `inbox.count` and nothing else, and the dock's
// Notifications tab reaches it (CS-7.39). The kit panel's own lines are
// `mp-7-3-notifications*.test.tsx`; the server's crossings are
// `mp-7-3-inbox-isolation.test.tsx`.

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { dockTabs } from '../../apps/web/src/panels.ts';
import { matchRoute, pathTo } from '../../apps/web/src/routes.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { mount, settle, type Mounted } from './mount.tsx';

type Draw = (context: Record<string, unknown>) => ReactElement;

/** The inbox's screen, looked up as the application looks it up. */
const drawInbox = (): Draw | undefined =>
  (SCREENS as unknown as Readonly<Record<string, Draw | undefined>>)['agency:inbox'];

const entry = (id: string, key: string, over: Record<string, unknown> = {}) => ({
  id,
  reason: 'assignment',
  workState: 'open',
  access: 'readable',
  owed: true,
  counted: true,
  raisedAt: `2026-09-30T0${id}:00:00.000Z`,
  closedAt: null,
  seenAt: null,
  lastDelivery: null,
  task: { key, title: `Task ${key}` },
  ...over,
});

const INBOX = [
  entry('1', 'T-1'),
  entry('2', 'T-2', { reason: 'mention' }),
  entry('3', 'T-3', { reason: 'run_finished', owed: false, counted: false }),
];

const reply = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/** A client whose server answers the two inbox reads, recording every call. */
function served(owed: number): { client: OperationsClient; calls: string[] } {
  const calls: string[] = [];
  const client = new OperationsClient({
    origin: 'http://api.test',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (url) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path.endsWith('/inbox/read')) return Promise.resolve(reply({ ok: true, inbox: INBOX }));
      if (path.endsWith('/inbox/count')) return Promise.resolve(reply({ ok: true, owed }));
      return Promise.resolve(new Response('{}', { status: 404 }));
    },
  });
  return { client, calls };
}

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe('MP-7-3 inbox one list', () => {
  it('/inbox/ is its own route, drawn from inbox.read and inbox.count alone, one list and one owed count', async () => {
    expect(matchRoute('/inbox/')?.id).toBe('agency:inbox');
    const draw = drawInbox();
    expect(draw, 'the inbox route has a screen').toBeTypeOf('function');
    const { client, calls } = served(2);
    const opened: string[] = [];
    view = await mount(
      (draw as Draw)({
        client,
        grantKey: 'alpha:ada',
        params: {},
        notice: null,
        storage: null,
        navigate: (path: string) => opened.push(path),
      }),
    );
    await settle();
    await settle();
    expect(view.find('h1')?.textContent).toBe('Inbox');
    expect(view.all('[role="tablist"]')).toHaveLength(1);
    expect(view.all('a.nt__row').map((row) => row.getAttribute('href'))).toEqual([
      '/task/T-2',
      '/task/T-1',
      '/task/T-3',
    ]);
    // The owed figure is inbox.count's, never a tally of the rows drawn.
    expect(view.find('.nt__sum b')?.textContent).toBe('2');
    // Beside the two reads, only the tab's live stream (C4 notifications live).
    expect(calls.toSorted()).toEqual([
      '/api/b/alpha/inbox/count',
      '/api/b/alpha/inbox/read',
      '/api/b/alpha/live',
    ]);

    // A row opens its own task through the application's navigation.
    await view.click('a[href="/task/T-1"]');
    expect(opened).toEqual(['/task/T-1']);
  });

  it("the dock's Notifications tab opens the inbox, the screen at /inbox/", () => {
    const tab = dockTabs().find((each) => each.id === 'notifs');
    expect(tab).toMatchObject({ label: 'Notifications', icon: 'bell', route: 'agency:inbox' });
    expect(tab === undefined ? null : pathTo(tab.route)).toBe('/inbox/');
  });
});
