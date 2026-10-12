// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A selected project's own client, which the New task door files, follows the
// board's live reads: a change to the project's client reaches the door with
// the board's next read, and a denial takes the client off the door with the
// board's rows.

import { afterEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';
import { json } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

const BOARD = '22222222-2222-4222-8222-222222222222';
const CLIENT_A = '11111111-1111-4111-8111-111111111111';
const CLIENT_B = '33333333-3333-4333-8333-333333333333';
const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };

/** The project's API: its client, a switch to refuse every task read, and the live stream. */
function projectServer() {
  const state = { client: CLIENT_A, name: 'Client A', refused: false };
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const reply = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const url = new URL(String(input), 'http://local');
    if (url.pathname.endsWith('/live')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push(controller);
            init?.signal?.addEventListener('abort', () => {
              streams.splice(streams.indexOf(controller), 1);
            });
          },
        }),
      );
    }
    const path = url.pathname;
    if (state.refused && (path.endsWith('/task/read') || path.endsWith('/task/board')))
      return json(DENIED, 403);
    if (path.endsWith('/task/read')) {
      const project = task({
        id: BOARD,
        key: 'WEB-PROJECT',
        title: 'Website rebuild',
        client: state.client,
        clientSummary: { kind: 'readable', name: state.name },
      });
      return json({ ok: true, task: project, states: [] });
    }
    if (path.endsWith('/task/board')) return json({ ok: true, tasks: [] });
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (path.endsWith('/client/list')) return json({ ok: true, clients: [] });
    return json({ ok: true });
  };
  const fetch: typeof globalThis.fetch = (input, init) => Promise.resolve(reply(input, init));
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return {
    client,
    state,
    invalidate: () => {
      for (const stream of streams)
        stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    },
  };
}

const went: string[] = [];

const door = (view: Awaited<ReturnType<typeof mount>>) =>
  view.find('[data-projects-new-task]') as HTMLElement;

async function opened(server: ReturnType<typeof projectServer>) {
  window.history.replaceState(null, '', `/projects/?board=${BOARD}`);
  const view = await mount(
    <Projects
      client={server.client}
      grantKey="alpha:owner"
      navigate={(path) => went.push(path)}
      canFileTask
    />,
  );
  await tick();
  await tick();
  expect(door(view).dataset['newTaskClient']).toBe(CLIENT_A);
  expect(door(view).dataset['newTaskClientName']).toBe('Client A');
  return view;
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

it('a board denial takes the project’s client off the New task door', async () => {
  const server = projectServer();
  const view = await opened(server);
  server.state.refused = true;
  server.invalidate();
  await tick();
  await tick();
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(door(view).dataset['newTaskClient']).toBeUndefined();
  expect(door(view).dataset['newTaskClientName']).toBeUndefined();
  await view.unmount();
});

it('a change to the project’s client reaches the New task door with the board’s next read', async () => {
  const server = projectServer();
  const view = await opened(server);
  server.state.client = CLIENT_B;
  server.state.name = 'Client B';
  server.invalidate();
  await tick();
  await tick();
  expect(door(view).dataset['newTaskClient']).toBe(CLIENT_B);
  expect(door(view).dataset['newTaskClientName']).toBe('Client B');
  await view.unmount();
});
