// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function, require-await -- the reviewer's proof, kept as written */
import { afterEach, expect, it } from 'vitest';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';
import { task, tick } from './task-page-stub.tsx';
import { held, json } from './work-log-stand-in.tsx';

const BOARD = '22222222-2222-4222-8222-222222222222';
const CLIENT = '11111111-1111-4111-8111-111111111111';
const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
const project = {
  ok: true,
  task: task({ id: BOARD, client: CLIENT, clientSummary: { kind: 'readable', name: 'Client A' } }),
  states: [],
};
afterEach(() => window.history.replaceState(null, '', '/'));

it('a reread after denial cannot restore the project’s client without board admission', async () => {
  const deniedBoard = held();
  const metadata = held();
  const retry = held();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let refreshing = false;
  let boardReads = 0;
  let taskReads = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), 'http://local').pathname;
    if (path.endsWith('/live'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            init?.signal?.addEventListener('abort', () => streams.delete(controller));
          },
        }),
      );
    if (path.endsWith('/task/read')) {
      taskReads += 1;
      return refreshing ? metadata.response : json(project);
    }
    if (path.endsWith('/task/board')) {
      boardReads += 1;
      return boardReads === 1
        ? json({ ok: true, tasks: [] })
        : boardReads === 2
          ? deniedBoard.response
          : retry.response;
    }
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (path.endsWith('/client/list')) return json({ ok: true, clients: [] });
    return json({ ok: true });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const screen = (changes: number) => (
    <Projects
      client={client}
      grantKey="alpha:owner"
      navigate={() => {}}
      canFileTask
      taskPanel={{ open: () => {}, changes }}
    />
  );
  window.history.replaceState(null, '', `/projects/?board=${BOARD}`);
  const view = await mount(screen(0));
  await tick();
  await tick();
  const door = () => view.host.querySelector<HTMLButtonElement>('[data-projects-new-task]');
  expect(door()?.dataset['newTaskClient']).toBe(CLIENT);
  refreshing = true;
  for (const stream of streams)
    stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
  await tick();
  expect(taskReads).toBe(2);
  deniedBoard.release(DENIED);
  await tick();
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  metadata.release(project);
  await tick();
  expect(door()?.dataset['newTaskClient']).toBeUndefined();
  // A change in an already open task panel starts another board read, but
  // does not reread the selected project's metadata. Access is still revoked.
  await view.render(screen(1));
  await tick();
  expect(boardReads).toBe(3);
  expect(taskReads).toBe(2);
  expect(view.find('[data-outcome="loading"]')).not.toBeNull();
  expect(
    door()?.dataset['newTaskClient'],
    'no board read has admitted the reader since denial',
  ).toBeUndefined();
  expect(door()?.dataset['newTaskClientName']).toBeUndefined();
  retry.release(DENIED);
  await tick();
});
