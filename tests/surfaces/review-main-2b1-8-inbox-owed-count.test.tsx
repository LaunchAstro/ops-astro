// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-MAIN-2B1-8: the Inbox page's owed figure comes from `inbox.count`,
// never from a tally of the owed rows it drew. INBOX holds two owed rows, so
// the server's count is set to 5: a screen that counted its own rows shows 2.

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
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

describe('REVIEW-MAIN-2B1-8 inbox owed figure', () => {
  it('REVIEW-MAIN-2B1-8: the Inbox owed figure is inbox.count, not the owed rows drawn', async () => {
    const draw = drawInbox();
    expect(draw, 'the inbox route has a screen').toBeTypeOf('function');
    expect(
      INBOX.filter((row) => row.owed),
      'two owed rows are drawn',
    ).toHaveLength(2);
    const { client } = served(5);
    view = await mount(
      (draw as Draw)({
        client,
        grantKey: 'alpha:ada',
        params: {},
        notice: null,
        storage: null,
        navigate: () => {},
      }),
    );
    await settle();
    await settle();
    expect(view.all('a.nt__row')).toHaveLength(3);
    expect(view.find('.nt__sum b')?.textContent).toBe('5');
  });
});
