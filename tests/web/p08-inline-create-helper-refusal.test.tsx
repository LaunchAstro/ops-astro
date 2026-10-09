// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import {
  closeAll,
  CreateServer,
  draftTab,
  inline,
  open,
  retry,
} from './p05-inline-create-support.ts';
const KEY = 'ops-astro.create-attempts';
afterEach(closeAll);

it('a fresh CreateTask write refusal sends no command and keeps an explicit recovery gesture', async () => {
  const server = new CreateServer();
  const tab = draftTab();
  const write = tab.setItem.bind(tab);
  tab.setItem = (key, raw) => {
    if (key === KEY) throw new Error('No durable create copy');
    write(key, raw);
  };
  const app = await open(server, tab);
  await inline(app, 'Fresh storage refused create');
  expect(server.commands('/task/create')).toHaveLength(0);
  expect(server.applied).toHaveLength(0);
  expect(app.view.text()).toContain('No new task was sent');
  expect(app.view.find('[data-create-retry]')).toHaveProperty('disabled', false);
});

it.each(['owner', 'operation', 'operand', 'truncated', 'unreadable'] as const)(
  'actual CreateTask retains its unknown identity and refuses a %s recovery readback',
  async (failure) => {
    const server = new CreateServer();
    server.lose('/task/create', 'after');
    const app = await open(server);
    await inline(app, 'Create helper original operands');
    const original = server.commands('/task/create')[0]!;
    const operation = String(original.body['operationId']);
    const read = app.storage.getItem.bind(app.storage);
    const write = app.storage.setItem.bind(app.storage);
    const exact = read(KEY);
    if (exact === null) throw new Error('Original create journal not durable');
    const wrong =
      failure === 'owner'
        ? exact.replace('"owner":"', '"owner":"foreign-')
        : failure === 'operation'
          ? exact.replace(operation, '33333333-3333-4333-8333-333333333333')
          : failure === 'operand'
            ? exact.replace('Create helper original operands', 'Changed create operands')
            : exact.slice(0, -1);
    app.storage.setItem = (key, raw) => {
      if (key === KEY) throw new Error('Recovery write refused');
      write(key, raw);
    };
    app.storage.getItem = (key) => {
      if (key !== KEY) return read(key);
      if (failure === 'unreadable') throw new Error('Recovery readback refused');
      return wrong;
    };
    await retry(app, operation);
    expect(server.commands('/task/create')).toHaveLength(1);
    expect(server.applied).toHaveLength(1);
    expect(app.view.text()).toContain('No replay was sent');
    expect(app.view.find(`[data-create-retry="${operation}"]`)).toHaveProperty('disabled', false);
    app.storage.getItem = read;
    expect(read(KEY)).toBe(exact);
    app.storage.setItem = write;
    await retry(app, operation);
    expect(server.commands('/task/create')).toHaveLength(2);
    expect(server.commands('/task/create')[1]).toStrictEqual(original);
    expect(server.applied).toHaveLength(1);
    expect(server.tasks).toHaveLength(1);
  },
);
