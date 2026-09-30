// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C4 notifications live on the page: the board's stream (INB-1f) is the
// `board` topic on the tab's one hub, so the board, its inbox panels, the
// Inbox screen and any task page share one connection. The board topic's
// `inbox` signal reaches its pages as `inbox`, and its invalidate as `changed`;
// a new notification and the owed count appear without a reload.

import { act, type ReactElement } from 'react';
import { afterEach, expect, it } from 'vitest';
import { createLiveHub, hubOf, type LiveChange } from '../../apps/web/src/data/live.ts';
import { useBoardLive } from '../../apps/web/src/data/board-live.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { InboxScreen } from '../../apps/web/src/screens/Inbox.tsx';
import { mount, settle, type Mounted } from './mount.tsx';

const pause = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  });
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const entry = (id: string, key: string) => ({
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
});

/** A server answering the inbox reads and the live channel, whose stream the case writes into. */
function server() {
  const inbox = [entry('1', 'T-1')];
  const state = { owed: 1 };
  const joins: string[] = [];
  const reads: string[] = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.includes('/live')) {
      joins.push(at);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
      return Promise.resolve(response);
    }
    reads.push(at);
    if (at.endsWith('/inbox/read')) return Promise.resolve(json({ ok: true, inbox: [...inbox] }));
    if (at.endsWith('/inbox/count')) return Promise.resolve(json({ ok: true, owed: state.owed }));
    return Promise.reject(new Error(`unrouted ${at}`));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    inbox,
    state,
    joins,
    reads,
    send: (event: string, topic: string) =>
      stream?.enqueue(encoder.encode(`event: ${event}\ndata: ${topic}\n\n`)),
  };
}

const ignore = (): void => {};

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

it('C4 notifications live (hub): the board topic joins beside a task topic on one stream; its inbox signal says inbox, its invalidate changed', async () => {
  const joins: (readonly string[])[] = [];
  let send: (event: string, topic: string) => void = ignore;
  const encoder = new TextEncoder();
  const hub = createLiveHub(
    async (topics) => {
      joins.push(topics);
      return await Promise.resolve(
        new ReadableStream<Uint8Array>({
          start(controller) {
            send = (event, topic) =>
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${topic}\n\n`));
          },
        }),
      );
    },
    { visible: () => true },
  );
  const board: LiveChange[] = [];
  const task: LiveChange[] = [];
  const stops = [
    hub.follow('board', (change) => board.push(change)),
    hub.follow('task:a', (change) => task.push(change)),
  ];
  await settle();
  expect(joins).toEqual([['board', 'task:a']]);
  send('inbox', 'board');
  send('invalidate', 'board');
  await settle();
  expect(board).toEqual(['inbox', 'changed']);
  expect(task).toEqual([]);
  for (const stop of stops) stop();
});

it('C4 notifications live (page): the Inbox screen follows the board topic and shows a new notification and its count with no reload', async () => {
  const api = server();
  view = await mount(<InboxScreen client={api.client} grantKey="alpha:ada" navigate={() => {}} />);
  await settle();
  await settle();
  expect(api.joins).toEqual(['/api/b/alpha/live?topic=board']);
  expect(view.all('a.nt__row')).toHaveLength(1);

  api.inbox.push(entry('2', 'T-2'));
  api.state.owed = 2;
  api.send('inbox', 'board');
  await pause();
  await settle();
  expect(view.all('a.nt__row').map((row) => row.getAttribute('href'))).toContain('/task/T-2');
  expect(view.find('.nt__sum b')?.textContent).toBe('2');
  expect(api.joins).toHaveLength(1);
});

it('C4 notifications live (board): the board and a task page share the tab’s one stream; an inbox signal re-reads the panels and not the board', async () => {
  const api = server();
  const heard = { board: 0, panel: 0 };
  function Board(): ReactElement | null {
    const follow = useBoardLive(api.client, 'alpha:ada', () => {
      heard.board += 1;
    });
    follow(() => {
      heard.panel += 1;
    });
    return null;
  }
  view = await mount(<Board />);
  const stop = hubOf(api.client).follow('task:a', () => {});
  await settle();
  await settle();
  expect(api.joins.every((at) => at.includes('/live?topic='))).toBe(true);
  expect(api.joins.at(-1)).toBe('/api/b/alpha/live?topic=board&topic=task%3Aa');

  api.send('inbox', 'board');
  await pause();
  expect(heard).toEqual({ board: 0, panel: 1 });
  api.send('invalidate', 'board');
  await pause();
  expect(heard).toEqual({ board: 1, panel: 2 });
  stop();
});
