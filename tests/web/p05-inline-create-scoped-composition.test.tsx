// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  closeAll,
  CreateServer,
  inline,
  open,
  operationOf,
  retry,
} from './p05-inline-create-support.ts';

afterEach(closeAll);
const OWN_BOARD = '/projects/?pool=aggregate&scope=own';
const CREATE_COPY = 'ops-astro.create-attempts';

it('a keyed scoped reader remount retains the exact create journal and a newer editor on replay', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Submitted before keyed scope change');
  const original = server.commands('/task/create')[0]!;
  const raw = app.storage.getItem(CREATE_COPY);
  expect(raw).not.toBeNull();
  await app.renderPath(OWN_BOARD);
  await app.tick();
  expect(server.commands('/task/board').at(-1)?.body).toStrictEqual({ mode: 'aggregate' });
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(app.storage.getItem(CREATE_COPY)).toBe(raw);
  expect(app.view.find('#create-title')).toHaveProperty('value', '');
  expect(app.view.find(`[data-create-retry="${operationOf(server)}"]`)).not.toBeNull();
  await app.view.type('#create-title', 'New editor after keyed scope change');
  await retry(app, operationOf(server));
  expect(server.commands('/task/create')[1]).toStrictEqual(original);
  expect(app.view.find('#create-title')).toHaveProperty(
    'value',
    'New editor after keyed scope change',
  );
  expect(server.tasks).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
});

it('an answer held across the keyed scope change settles through the current reader without clearing its editor', async () => {
  const server = new CreateServer();
  const release = server.hold('/task/create');
  const app = await open(server);
  await inline(app, 'Old reader submitted this create');
  const original = server.commands('/task/create')[0]!;
  const id = operationOf(server);
  const raw = app.storage.getItem(CREATE_COPY);
  expect(raw).not.toBeNull();
  expect(app.view.find('#create-title')).toHaveProperty('disabled', true);
  await app.renderPath(OWN_BOARD);
  await app.tick();
  expect(app.view.find('#create-title')).toHaveProperty('value', '');
  expect(app.view.find('#create-title')).toHaveProperty('disabled', false);
  expect(app.storage.getItem(CREATE_COPY)).toBe(raw);
  await app.view.type('#create-title', 'Current reader unsent draft');
  const readsBefore = server.commands('/task/board').length;
  await app.act(() => {
    release();
  });
  await app.tick();
  await app.tick();
  expect(server.commands('/task/create')).toStrictEqual([original]);
  expect(
    server
      .commands('/task/board')
      .slice(readsBefore)
      .map((read) => read.body),
  ).toStrictEqual([{ mode: 'aggregate' }]);
  expect(app.view.find('#create-title')).toHaveProperty('value', 'Current reader unsent draft');
  expect(app.view.find(`[data-create-retry="${id}"]`)).toBeNull();
  expect(JSON.parse(app.storage.getItem(CREATE_COPY) ?? '{}')).toHaveProperty('entries', {});
  expect(server.tasks).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
});
