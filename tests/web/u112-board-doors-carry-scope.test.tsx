// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// U112 Core 04 2, in the actual App: every Projects board door (the toolbar's
// New task, the quick-add and the empty board's door) opens the one kept draft
// with the board's own context: its client and project, the stage it is
// filtered to, and the priority and category its scope reads as. A door on a
// board with none of these guesses none of them.

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { json, unmountAll } from './perspective-support.tsx';
import { draft } from './draft-support.tsx';
import { task, tick } from './task-page-stub.tsx';
import { OrderedCreateServer, closeAll, drain, file, open } from './p05-draft-create-support.ts';
import { draftTab, PERSON } from './projects-draft-app-support.tsx';
import { readDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { boardDoor } from '../../apps/web/src/screens/projects/ProjectsToolbar.tsx';
import { doorContext } from '../../apps/web/src/screens/task/task-prefill.ts';
import { owningBoardAddress } from '../../apps/web/src/screens/task/board-door.tsx';

afterEach(closeAll);
afterEach(unmountAll);

const CLIENT = '11111111-1111-4111-8111-111111111111';
const BOARD = '22222222-2222-4222-8222-222222222222';
const FILTERS = JSON.stringify([
  { kind: 'priority', value: 2 },
  { kind: 'category', value: 'seo' },
]);
const STAGE = encodeURIComponent('stage:"Enquiries"');
const SCOPED = `/projects/?board=${BOARD}&client=${CLIENT}&filters=${encodeURIComponent(FILTERS)}&f=${STAGE}`;

const project = (id: string, title: string, client: string | null) => ({
  id,
  title,
  clientSet: client !== null,
  client: client === null ? null : { clientId: client, name: 'A client' },
});

const contextOf = (address: string) => {
  const door = document.createElement('button');
  for (const [name, value] of Object.entries(boardDoor(address, true)))
    if (value !== undefined) door.setAttribute(name, value);
  return doorContext(door);
};

describe('Core 04 2: board doors carry the board’s context into the draft', () => {
  it('a door names the board’s client, project, filtered stage, priority and category', () => {
    expect(contextOf(SCOPED)).toMatchObject({
      from: 'Tasks',
      clientId: CLIENT,
      boardId: BOARD,
      stage: 'enquiries',
      priority: 2,
      category: 'seo',
    });
  });

  it('two stages or two priorities in view guess neither', () => {
    const two = JSON.stringify([
      { kind: 'priority', value: 1 },
      { kind: 'priority', value: 3 },
    ]);
    const stages = encodeURIComponent('stage:"Enquiries",stage:"Sales"');
    const page = contextOf(`/projects/?board=none&filters=${encodeURIComponent(two)}&f=${stages}`);
    expect(page).not.toHaveProperty('stage');
    expect(page).not.toHaveProperty('priority');
    expect(page).toMatchObject({ clientId: null });
  });

  it('a Category filter files its category; two Category filters guess none', () => {
    const one = encodeURIComponent('stage:"Enquiries",category:"SEO"');
    expect(contextOf(`/projects/?board=none&f=${one}`)).toMatchObject({
      stage: 'enquiries',
      category: 'seo',
    });
    const two = encodeURIComponent('category:"SEO",category:"Content"');
    expect(contextOf(`/projects/?board=none&f=${two}`).category).toBeUndefined();
  });

  it('a door that may not file a task carries nothing', () => {
    expect(boardDoor(SCOPED, false)).toStrictEqual({});
  });
});

describe('Core 04 2: in the App, the board doors open the draft with that context', () => {
  // The board admits its reader only when they reach its client, and a door names no client otherwise.
  const reaching = (server: OrderedCreateServer): OrderedCreateServer => {
    const inner = server.fetch;
    server.fetch = async (url, init) =>
      String(url).endsWith('/client/list')
        ? json({ ok: true, clients: [{ clientId: CLIENT, name: 'A client' }] })
        : await inner(url, init);
    return server;
  };

  it('the toolbar’s New task opens the kept draft with that context', async () => {
    const app = await open(reaching(new OrderedCreateServer()), draftTab(), SCOPED);
    await file(app);
    // A fresh draft is kept from its first edit.
    await app.view.type('#panel-draft-name', 'Filed from the toolbar');
    expect(readDraft(app.storage, PERSON)).toMatchObject({
      clientId: CLIENT,
      boardId: BOARD,
      stage: 'enquiries',
      priority: 2,
      category: 'seo',
    });
  });

  it('a name typed after opening the draft keeps the board context', async () => {
    const app = await open(reaching(new OrderedCreateServer()), draftTab(), SCOPED);
    await file(app);
    await app.view.type('#panel-draft-name', 'Typed on a filtered board');
    await drain(app);
    expect(readDraft(app.storage, PERSON)).toMatchObject({
      title: 'Typed on a filtered board',
      clientId: CLIENT,
      boardId: BOARD,
      stage: 'enquiries',
      priority: 2,
    });
  });
});

describe('a client’s project board, at the address the app writes for it', () => {
  // The address a task's Open its board link writes: the project, no client.
  const ADDRESS = owningBoardAddress({
    key: 'WEB-1',
    board: { id: BOARD, readable: true, title: 'Website rebuild' },
  } as never)!;
  const serving = (server: OrderedCreateServer): OrderedCreateServer => {
    const inner = server.fetch;
    const served = task({
      id: BOARD,
      key: 'WEB-PROJECT',
      title: 'Website rebuild',
      client: CLIENT,
      clientSummary: { kind: 'readable', name: 'Client B' },
    });
    server.fetch = async (url, init) => {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        recordId?: unknown;
      };
      return String(url).endsWith('/task/read') && body.recordId === BOARD
        ? json({ ok: true, task: served, states: [] })
        : await inner(url, init);
    };
    return server;
  };

  it('every door files the draft on the project’s own client', async () => {
    expect(ADDRESS).not.toContain('client=');
    const app = await open(serving(new OrderedCreateServer()), draftTab(), ADDRESS);
    await drain(app);
    for (const door of ['[data-projects-new-task]', '[data-projects-empty-new-task]'])
      expect(app.view.host.querySelector<HTMLElement>(door)?.dataset['newTaskClient'], door).toBe(
        CLIENT,
      );
    await file(app);
    await app.view.type('#panel-draft-name', 'Filed on the client’s project');
    expect(readDraft(app.storage, PERSON)).toMatchObject({ clientId: CLIENT, boardId: BOARD });
  });
});

/** A server whose project read steers (`at`), with the tab's live stream. */
function projectServer() {
  const server = new OrderedCreateServer();
  const inner = server.fetch;
  const at = { client: CLIENT, name: 'Client A', refused: false };
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  server.fetch = async (url, init) => {
    const path = new URL(String(url), 'http://fixture.test').pathname;
    if (path.endsWith('/live'))
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            init?.signal?.addEventListener('abort', () => streams.delete(controller));
          },
        }),
      );
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      recordId?: unknown;
    };
    if (!path.endsWith('/task/read') || body.recordId !== BOARD) return await inner(url, init);
    return at.refused
      ? json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: ['task'], fixes: [] })
      : json({
          ok: true,
          task: task({
            id: BOARD,
            key: 'WEB-PROJECT',
            title: 'Website rebuild',
            client: at.client,
            clientSummary: { kind: 'readable', name: at.name },
          }),
          states: [],
        });
  };
  return { server, at, streams };
}

/** The App on Client A's empty project, at the address the app writes for it. */
async function onEmptyProject() {
  const { server, at, streams } = projectServer();
  const app = await open(server, draftTab(), `/projects/?board=${BOARD}`);
  await drain(app);
  const door = () => app.view.host.querySelector<HTMLElement>('[data-projects-new-task]');
  const invalidate = async () => {
    await app.act(() => {
      for (const stream of streams)
        stream.enqueue(new TextEncoder().encode('event: invalidate\ndata: board\n\n'));
    });
    await drain(app);
  };
  expect(streams.size, 'the App must hold the tab’s live stream').toBeGreaterThan(0);
  expect(door()?.dataset['newTaskClient']).toBe(CLIENT);
  expect(door()?.dataset['newTaskClientName']).toBe('Client A');
  return { app, server, at, door, invalidate };
}

describe('a client’s empty project board, after a live change or a board denial', () => {
  const CLIENT_B = '33333333-3333-4333-8333-333333333333';

  it('a board denial withdraws the project’s client from New task, and a later live change keeps it withdrawn', async () => {
    const { app, server, at, door, invalidate } = await onEmptyProject();
    server.boardDenied = true;
    at.refused = true;
    await invalidate();
    expect(app.view.host.textContent).toContain('You are not permitted to see this board.');
    expect(door()?.dataset['newTaskClient']).toBeUndefined();
    expect(door()?.dataset['newTaskClientName']).toBeUndefined();
    // The board admits again but the project's own read still refuses: nothing names Client A.
    server.boardDenied = false;
    await invalidate();
    expect(door()?.dataset['newTaskClient']).toBeUndefined();
    expect(door()?.dataset['newTaskClientName']).toBeUndefined();
  });

  it('a live change of the project’s client moves New task onto the new client', async () => {
    const { app, at, door, invalidate } = await onEmptyProject();
    Object.assign(at, { client: CLIENT_B, name: 'Client B' });
    await invalidate();
    expect(door()?.dataset['newTaskClient']).toBe(CLIENT_B);
    expect(door()?.dataset['newTaskClientName']).toBe('Client B');
    await file(app);
    await app.view.type('#panel-draft-name', 'Filed on the project’s new client');
    expect(readDraft(app.storage, PERSON)).toMatchObject({ clientId: CLIENT_B, boardId: BOARD });
  });
});

describe('Core 04 4: the draft offers only projects its client’s work may join', () => {
  it('another client’s project is not offered; the agency’s and the client’s own are', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    const fetch = (() =>
      Promise.resolve(
        json({
          ok: true,
          tasks: [
            project('44444444-4444-4444-8444-444444444444', 'Agency site', null),
            project(BOARD, 'Website rebuild', CLIENT),
            project('55555555-5555-4555-8555-555555555555', 'Their launch', OTHER),
          ],
          viewer: 'p',
          owed: 0,
        }),
      )) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch,
    });
    const { view } = await draft({ client, scope: { clientId: CLIENT, from: 'Client A' } });
    await act(() => {
      view.host.querySelector<HTMLSelectElement>('#panel-draft-board')?.focus();
    });
    await tick();
    const offered = [
      ...view.host.querySelectorAll<HTMLOptionElement>('#panel-draft-board option'),
    ].map((option) => option.textContent);
    expect(offered).toStrictEqual(['None', 'Agency site', 'Website rebuild']);
  });
});
