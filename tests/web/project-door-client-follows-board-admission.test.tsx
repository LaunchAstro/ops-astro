// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// A selected project's own client rides on the Projects board's New task
// doors only while this reader's board read admits them: a live change
// rereads it, a board denial or a loading board after one withdraws it, and
// a new reader's first commit carries nothing the last reader's board named.

import { useLayoutEffect, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { mount } from '../surfaces/mount.tsx';
import { json } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import { held } from './work-log-stand-in.tsx';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BOARD = '22222222-2222-4222-8222-222222222222';
const OTHER = '66666666-6666-4666-8666-666666666666';
const DENIED = { refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] };
const EMPTY = { ok: true, tasks: [] };
const projectOn = (client: string, name: string) => ({
  ok: true,
  task: task({ id: BOARD, client, clientSummary: { kind: 'readable', name } }),
  states: [],
});
const door = () => document.querySelector<HTMLElement>('[data-projects-new-task]');

/** An API whose board and project answers a test steers, with the tab's live stream. */
function steeredApi() {
  const serve: { board: () => Promise<Response>; project: () => Promise<Response> } = {
    board: () => Promise.resolve(json(EMPTY)),
    project: () => Promise.resolve(json(projectOn(CLIENT, 'Client A'))),
  };
  const reads = { project: 0 };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
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
      reads.project += 1;
      return await serve.project();
    }
    if (path.endsWith('/task/board')) return await serve.board();
    if (path.endsWith('/client/list'))
      return json({ ok: true, clients: [{ clientId: CLIENT, name: 'Client A' }] });
    if (path.endsWith('/person/list')) return json({ ok: true, persons: [] });
    return json({ ok: true });
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const invalidate = async () => {
    for (const stream of streams)
      stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    await tick();
    await tick();
  };
  return { client, serve, reads, invalidate };
}

/** Records the door's client at each commit of the page, before any passive effect runs. */
function Probe(props: {
  readonly committed: (string | undefined)[];
  readonly children: ReactNode;
}): ReactNode {
  useLayoutEffect(() => {
    props.committed.push(door()?.dataset['newTaskClient']);
  });
  return props.children;
}

/** The Projects page at `address`, probed at every commit. */
async function projectsPage(address = `/projects/?board=${BOARD}`) {
  const api = steeredApi();
  const committed: (string | undefined)[] = [];
  const screen = (changes: number, grantKey = 'alpha:owner', on = api.client): ReactElement => (
    <Probe committed={committed}>
      <Projects
        client={on}
        grantKey={grantKey}
        navigate={() => {}}
        canFileTask
        taskPanel={{ open: () => {}, changes }}
      />
    </Probe>
  );
  window.history.replaceState(null, '', address);
  const view = await mount(screen(0));
  await tick();
  await tick();
  return { ...api, view, screen, committed };
}

/** Every value the door's client holds from now on, through each commit. */
function clientsSeen(): () => readonly (string | undefined)[] {
  const values: (string | undefined)[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) values.push(record.oldValue ?? undefined);
  });
  observer.observe(document.body, {
    subtree: true,
    attributeOldValue: true,
    attributeFilter: ['data-new-task-client'],
  });
  return () => {
    observer.disconnect();
    return [...values, door()?.dataset['newTaskClient']];
  };
}

describe('a project’s client on its doors follows the board’s own reads', () => {
  it('a board denial withdraws the project’s client and its name from the door', async () => {
    const { view, serve, invalidate } = await projectsPage();
    expect(door()?.dataset['newTaskClientName']).toBe('Client A');
    serve.board = () => Promise.resolve(json(DENIED));
    serve.project = () => Promise.resolve(json(DENIED));
    await invalidate();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    expect(door()?.dataset['newTaskClient']).toBeUndefined();
    expect(door()?.dataset['newTaskClientName']).toBeUndefined();
  });

  it('a change of the project’s client reaches the door with the board’s reread', async () => {
    const { serve, invalidate } = await projectsPage();
    expect(door()?.dataset['newTaskClient']).toBe(CLIENT);
    serve.project = () => Promise.resolve(json(projectOn(OTHER, 'Client B')));
    await invalidate();
    expect(door()?.dataset['newTaskClient']).toBe(OTHER);
    expect(door()?.dataset['newTaskClientName']).toBe('Client B');
  });
});

describe('a project’s client on its doors waits for this reader’s board to admit them', () => {
  it('after a denial, only a project read begun once the board admits again names the client', async () => {
    const { view, serve, reads, screen, invalidate } = await projectsPage();
    const across = held();
    serve.project = () => across.response;
    serve.board = () => Promise.resolve(json(DENIED));
    await invalidate();
    expect(view.find('[data-outcome="denied"]')).not.toBeNull();
    const seen = clientsSeen();
    // The project answer in flight across the denial lands after it.
    across.release(projectOn(CLIENT, 'Client A'));
    await tick();
    serve.board = () => Promise.resolve(json(EMPTY));
    serve.project = () => Promise.resolve(json(projectOn(OTHER, 'Client B')));
    const before = reads.project;
    await view.render(screen(1));
    await tick();
    await tick();
    expect(reads.project).toBe(before + 1);
    expect(seen()).not.toContain(CLIENT);
    expect(door()?.dataset['newTaskClient']).toBe(OTHER);
  });

  it('a new reader’s first commit carries no client the last reader’s board named', async () => {
    const address = `/projects/?f=${encodeURIComponent('client:"Client A"')}`;
    const { view, screen, committed } = await projectsPage(address);
    expect(door()?.dataset['newTaskClient']).toBe(CLIENT);
    // The second reader's reads are still out.
    const pending = new OperationsClient({
      origin: '',
      businessKey: 'beta',
      signedIn: true,
      fetch: () => new Promise<Response>(() => {}),
    });
    const from = committed.length;
    await view.render(screen(0, 'beta:owner', pending));
    expect(committed[from]).toBeUndefined();
    expect(door()?.dataset['newTaskClient']).toBeUndefined();
  });
});
