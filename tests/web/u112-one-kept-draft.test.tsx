// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// U112 and U106 (P05, P14), in the actual App: every Projects door enters the
// one kept draft, and a Create whose answer was lost
// holds the draft until its own retry finishes it with one task and one of
// each part.

import { afterEach, expect, it } from 'vitest';
import {
  OrderedCreateServer,
  PARTY,
  close,
  closeAll,
  copied,
  drain,
  file,
  open,
  seeded,
  submit,
  type Mounted,
} from './p05-draft-create-support.ts';
import { readAttempt, readDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { PERSON } from './projects-draft-app-support.tsx';
import { json } from './work-log-stand-in.tsx';

afterEach(closeAll);

const nameOf = (app: Mounted): string | null =>
  app.view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.value ?? null;

async function newTask(app: Mounted, title?: string): Promise<void> {
  await app.view.click('[data-projects-new-task]');
  await drain(app);
  if (title !== undefined) await app.view.type('#panel-draft-name', title);
}

/** The board's own New task door, carrying a typed name in its prefill as a door may. */
async function namedDoor(app: Mounted, title: string): Promise<void> {
  const door = app.view.find('[data-projects-new-task]');
  if (door instanceof HTMLElement) door.dataset['newTaskTitle'] = title;
  await newTask(app);
}

it('Core 04 1: New task opens the one kept draft and keeps its typed name without creating', async () => {
  const server = new OrderedCreateServer();
  const app = await open(server);
  await newTask(app, 'Typed at the board');
  expect(app.view.find('[data-draft-panel]')).not.toBeNull();
  expect(nameOf(app)).toBe('Typed at the board');
  expect(server.writes()).toStrictEqual([]);
  expect(readDraft(app.storage, PERSON)?.title).toBe('Typed at the board');
  const tab = copied(app.storage);
  await close(app);
  const next = await open(server, tab);
  await file(next);
  expect(nameOf(next)).toBe('Typed at the board');
  await submit(next);
  expect(server.parents.map((task) => task.title)).toStrictEqual(['Typed at the board']);
});

it('a kept draft that already has a name keeps it when New task is used', async () => {
  const server = new OrderedCreateServer();
  const app = await open(server, seeded({ title: 'Left half done', note: 'Keep me' }));
  await newTask(app);
  expect(nameOf(app)).toBe('Left half done');
  expect(readDraft(app.storage, PERSON)).toMatchObject({
    title: 'Left half done',
    note: 'Keep me',
  });
});

it('an unnamed kept draft given a name at another client’s board goes to that client, not its own project', async () => {
  const clientA = '11111111-1111-4111-8111-111111111111';
  const clientB = { clientId: '22222222-1111-4111-8111-111111111111', name: 'Example Client B' };
  const server = new OrderedCreateServer();
  const served = server.fetch;
  server.fetch = (url, init) =>
    String(url).endsWith('/client/list')
      ? Promise.resolve(json({ ok: true, clients: [clientB] }))
      : served(url, init);
  const app = await open(
    server,
    seeded({
      clientId: clientA,
      boardId: '33333333-1111-4111-8111-111111111111',
      due: '2026-10-20',
    }),
    `/projects/?pool=aggregate&client=${clientB.clientId}`,
  );
  await namedDoor(app, 'Client B homepage fix');
  expect(readDraft(app.storage, PERSON)).toMatchObject({
    title: 'Client B homepage fix',
    clientId: clientB.clientId,
    boardId: null,
    due: '2026-10-20',
  });
  await submit(app);
  expect(server.commands('/task/set_party').map((one) => one.body['fields'])).toStrictEqual([
    { client: clientB.clientId },
  ]);
  expect(server.commands('/task/move')).toStrictEqual([]);
});

it('the empty board’s New task opens the same kept draft', async () => {
  const server = new OrderedCreateServer();
  const app = await open(server, seeded({ title: 'Started from the toolbar' }));
  await app.view.click('[data-projects-empty-new-task]');
  await drain(app);
  expect(nameOf(app)).toBe('Started from the toolbar');
});

it('Core 04 3: a part with no answer holds the draft; Retry after a reload makes one task and one of each part', async () => {
  const server = new OrderedCreateServer();
  const app = await open(
    server,
    seeded({ title: 'Partly written', note: 'From the call', steps: ['Draft copy'] }),
  );
  await file(app);
  server.lose('/task/comment', 'after');
  await submit(app);
  expect(server.parents).toHaveLength(1);
  expect(app.view.find('[data-draft-unsettled]')).not.toBeNull();
  expect(app.view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.readOnly).toBe(true);
  const tab = copied(app.storage);
  await close(app);
  const next = await open(server, tab);
  await file(next);
  expect(next.view.find('[data-draft="create"]')?.textContent).toBe('Retry Create');
  await submit(next);
  expect(server.parents).toHaveLength(1);
  expect(server.applied.filter((one) => one.path === '/task/comment')).toHaveLength(1);
  expect(server.children).toHaveLength(1);
  expect(readDraft(tab, PERSON)).toBeNull();
});

it('a part replay refused on Retry may already have applied: the draft is held and nothing reads as not added', async () => {
  const server = new OrderedCreateServer();
  const app = await open(
    server,
    seeded({ title: 'Scoped work', clientId: PARTY, note: 'Call notes' }),
  );
  await file(app);
  server.lose('/task/set_party', 'after');
  await submit(app);
  expect(server.applied.filter((one) => one.path === '/task/set_party')).toHaveLength(1);
  // The authority behind the stored answer is withdrawn before the retry.
  server.deniedPaths.add('/task/set_party');
  await submit(app);
  expect(app.view.find('[data-draft-missed]')).toBeNull();
  expect(app.view.find('[data-draft-refusal]')?.textContent).toContain(
    'The task may already have the client: check it before you retry.',
  );
  expect(app.view.find('[data-draft-unsettled]')).not.toBeNull();
  expect(readAttempt(app.storage, PERSON)).not.toBeNull();
  expect(server.applied.filter((one) => one.path === '/task/comment')).toStrictEqual([]);
});
