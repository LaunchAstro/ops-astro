// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
//
// U112 and U106 (P05, P14), in the actual App: every Projects door enters the
// one kept draft, the quick-add included, and a Create whose answer was lost
// holds the draft until its own retry finishes it with one task and one of
// each part.

import { afterEach, expect, it } from 'vitest';
import {
  OrderedCreateServer,
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
import { readDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { PERSON } from './projects-draft-app-support.tsx';

afterEach(closeAll);

const nameOf = (app: Mounted): string | null =>
  app.view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.value ?? null;

async function quickAdd(app: Mounted, title: string): Promise<void> {
  await app.view.type('#create-title', title);
  await app.view.click('.projects__create button[type="submit"]');
  await drain(app);
}

it('Core 04 1: the quick-add opens the one kept draft with the typed name and creates nothing itself', async () => {
  const server = new OrderedCreateServer();
  const app = await open(server);
  await quickAdd(app, 'Typed at the board');
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

it('a kept draft that already has a name keeps it when the quick-add is used', async () => {
  const server = new OrderedCreateServer();
  const app = await open(server, seeded({ title: 'Left half done', note: 'Keep me' }));
  await quickAdd(app, 'Something else');
  expect(nameOf(app)).toBe('Left half done');
  expect(readDraft(app.storage, PERSON)).toMatchObject({
    title: 'Left half done',
    note: 'Keep me',
  });
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
