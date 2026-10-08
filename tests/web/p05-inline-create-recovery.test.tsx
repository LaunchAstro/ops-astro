// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// Private preparation. Every case remains unexecuted until the composed base is assigned.
import { afterEach, expect, it } from 'vitest';
import {
  close,
  closeAll,
  copied,
  CreateServer,
  inline,
  open,
  operationOf,
  retry,
} from './p05-inline-create-support.ts';
afterEach(closeAll);

it.each(['before', 'after'] as const)(
  'inline lost-%s reload explicitly replays its full original create',
  async (at) => {
    const server = new CreateServer();
    server.lose('/task/create', at);
    const first = await open(server);
    await inline(first, 'Held inline create');
    const sent = server.commands('/task/create')[0]!;
    expect(sent.body).toMatchObject({ fields: { title: 'Held inline create' }, board: null });
    expect(sent.body).not.toHaveProperty('expectedRevision');
    const tab = copied(first.storage);
    await close(first);
    const next = await open(server, tab);
    expect(server.commands('/task/create')).toHaveLength(1);
    await retry(next, operationOf(server));
    expect(server.commands('/task/create')[1]).toStrictEqual(sent);
    expect(server.tasks).toHaveLength(1);
    expect(server.applied).toHaveLength(1);
  },
);

it('a genuine second task does not replace the first unresolved entry', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'First unresolved task');
  const first = server.commands('/task/create')[0]!;
  await inline(app, 'Genuinely different task');
  expect(operationOf(server, 1)).not.toBe(operationOf(server));
  expect(server.tasks).toHaveLength(2);
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[2]).toStrictEqual(first);
  expect(server.tasks).toHaveLength(2);
  expect(server.applied).toHaveLength(2);
});

it('two independently unresolved tasks survive a fresh realm without hydration sends', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const first = await open(server);
  await inline(first, 'First held task');
  server.lose('/task/create', 'before');
  await inline(first, 'Second held task');
  const [one, two] = server.commands('/task/create');
  expect(operationOf(server, 1)).not.toBe(operationOf(server));
  const tab = copied(first.storage);
  await close(first);
  const next = await open(server, tab);
  expect(server.commands('/task/create')).toHaveLength(2);
  await retry(next, operationOf(server));
  await retry(next, operationOf(server, 1));
  expect(server.commands('/task/create')[2]).toStrictEqual(one);
  expect(server.commands('/task/create')[3]).toStrictEqual(two);
  expect(server.tasks).toHaveLength(2);
  expect(server.applied).toHaveLength(2);
});

it('unknown then canonical withheld success keeps its identity through reload', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const first = await open(server);
  await inline(first, 'Unknown authored title');
  const sent = server.commands('/task/create')[0]!;
  server.denied = true;
  await retry(first, operationOf(server));
  expect(first.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(first.view.find(`[data-create-retry="${operationOf(server)}"]`)).not.toBeNull();
  const tab = copied(first.storage);
  await close(first);
  const next = await open(server, tab);
  expect(server.commands('/task/create')).toHaveLength(2);
  server.denied = false;
  await retry(next, operationOf(server));
  expect(server.commands('/task/create')).toHaveLength(3);
  for (const request of server.commands('/task/create')) expect(request).toStrictEqual(sent);
  expect(server.tasks).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
});

it('same-word newer inline editing is not consumed by an older settlement', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Same words');
  await app.view.type('#create-title', 'Newer words');
  await app.view.type('#create-title', 'Same words');
  await retry(app, operationOf(server));
  expect(app.view.find('#create-title')).toHaveProperty('value', 'Same words');
  expect(server.applied).toHaveLength(1);
});

it('a Projects reader remount keeps the submitted entry independently of the next editor', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Before destination change');
  const sent = server.commands('/task/create')[0]!;
  await app.renderPath('/projects/?pool=aggregate&scope=own');
  await app.tick();
  await app.view.type('#create-title', 'Next scoped editor');
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[1]).toStrictEqual(sent);
  expect(app.view.find('#create-title')).toHaveProperty('value', 'Next scoped editor');
  expect(server.applied).toHaveLength(1);
});

it('ordinary route unmount retains custody and replays only on an explicit action', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Held across navigation');
  const sent = server.commands('/task/create')[0]!;
  await app.renderPath('/');
  await app.tick();
  await app.renderPath('/projects/');
  await app.tick();
  expect(server.commands('/task/create')).toHaveLength(1);
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[1]).toStrictEqual(sent);
  expect(server.applied).toHaveLength(1);
});

it('the actual App classifies a first canonical SCOPE refusal as a known decision', async () => {
  const server = new CreateServer();
  server.denied = true;
  const app = await open(server);
  await inline(app, 'First refused create');
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(server.applied).toHaveLength(0);
  expect(server.tasks).toHaveLength(0);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).not.toContain('may already have been created');
});
