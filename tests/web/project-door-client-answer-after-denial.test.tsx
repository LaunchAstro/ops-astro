// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Proofs from the independent review of #1404 (round 1), retitled by what they prove; their bodies are as written.
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
  task: task({
    id: BOARD,
    client: CLIENT,
    clientSummary: { kind: 'readable', name: 'Client A' },
  }),
  states: [],
};

afterEach(() => window.history.replaceState(null, '', '/'));

/* eslint-disable max-lines-per-function, require-await -- the review's proof, kept as written */
it('a client answer in flight cannot restore the door after board denial', async () => {
  const board = held();
  const metadata = held();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let refreshing = false;
  let revoked = false;
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
    if (revoked && (path.endsWith('/task/read') || path.endsWith('/task/board')))
      return json(DENIED, 403);
    if (path.endsWith('/task/read')) {
      taskReads += 1;
      return refreshing ? metadata.response : json(project);
    }
    if (path.endsWith('/task/board'))
      return refreshing ? board.response : json({ ok: true, tasks: [] });
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (path.endsWith('/client/list')) return json({ ok: true, clients: [] });
    return json({ ok: true });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  window.history.replaceState(null, '', `/projects/?board=${BOARD}`);
  const view = await mount(
    <Projects client={client} grantKey="alpha:owner" navigate={() => {}} canFileTask />,
  );
  await tick();
  await tick();
  const door = () => view.host.querySelector<HTMLButtonElement>('[data-projects-new-task]');
  expect(door()?.dataset['newTaskClient']).toBe(CLIENT);
  refreshing = true;
  for (const stream of streams)
    stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
  await tick();
  expect(taskReads).toBe(2);
  // Both reads began before the revoke. The metadata response was authorised
  // then, but its transport completes after the board has reported denial.
  revoked = true;
  board.release(DENIED);
  await tick();
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(door()?.dataset['newTaskClient']).toBeUndefined();
  metadata.release(project);
  await tick();
  expect(view.find('[data-outcome="denied"]')).not.toBeNull();
  expect(door()?.dataset['newTaskClient']).toBeUndefined();
  expect(door()?.dataset['newTaskClientName']).toBeUndefined();
});
/* eslint-enable max-lines-per-function, require-await */
