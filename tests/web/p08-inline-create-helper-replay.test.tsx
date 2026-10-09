// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  close,
  closeAll,
  copied,
  CreateServer,
  inline,
  open,
  retry,
} from './p05-inline-create-support.ts';
const KEY = 'ops-astro.create-attempts';
afterEach(closeAll);

it.each(['same-frame', 'fresh-realm'] as const)(
  'actual CreateTask explicitly replays an exact retained envelope after a throwing write in %s',
  async (realm) => {
    const server = new CreateServer();
    server.lose('/task/create', 'after');
    let app = await open(server);
    await inline(app, 'Create helper retained identity');
    const original = server.commands('/task/create')[0]!;
    const operation = String(original.body['operationId']);
    const exact = app.storage.getItem(KEY);
    expect(exact).toContain(operation);
    if (realm === 'fresh-realm') {
      const tab = copied(app.storage);
      await close(app);
      app = await open(server, tab);
    }
    expect(server.commands('/task/create')).toHaveLength(1);
    expect(server.applied).toHaveLength(1);
    const write = app.storage.setItem.bind(app.storage);
    app.storage.setItem = (key, raw) => {
      if (key === KEY) throw new Error('Write refused; original exact journal remains');
      write(key, raw);
    };
    await retry(app, operation);
    expect(server.commands('/task/create')).toHaveLength(2);
    expect(server.commands('/task/create')[1]).toStrictEqual(original);
    expect(server.applied).toHaveLength(1);
    expect(server.tasks).toHaveLength(1);
    expect(app.storage.getItem(KEY)).toBe(exact);
    expect(app.view.find('.projects__create button[type="submit"]')).toHaveProperty(
      'disabled',
      true,
    );
    await app.view.type('#create-title', 'Newer unsent helper draft');
    await app.view.click('[data-create-cleanup]');
    expect(server.commands('/task/create')).toHaveLength(2);
    app.storage.setItem = write;
    await app.view.click('[data-create-cleanup]');
    await app.tick();
    expect(server.commands('/task/create')).toHaveLength(2);
    expect(app.view.find('#create-title')).toHaveProperty('value', 'Newer unsent helper draft');
    expect(app.view.find('.projects__create button[type="submit"]')).toHaveProperty(
      'disabled',
      false,
    );
  },
);

it('actual CreateTask admits write-then-throw and durably empty cleanup without another command', async () => {
  const server = new CreateServer();
  const app = await open(server);
  const write = app.storage.setItem.bind(app.storage);
  app.storage.setItem = (key, raw) => {
    write(key, raw);
    if (key === KEY) throw new Error('Write answer refused after exact storage');
  };
  await inline(app, 'Create helper exact write then throw');
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
  expect(server.tasks).toHaveLength(1);
  expect(app.view.find('[data-create-cleanup]')).toBeNull();
  expect(app.storage.getItem(KEY)).toContain('"entries":{}');
  await app.view.type('#create-title', 'Next unsent task');
  expect(app.view.find('.projects__create button[type="submit"]')).toHaveProperty(
    'disabled',
    false,
  );
  expect(server.commands('/task/create')).toHaveLength(1);
});
