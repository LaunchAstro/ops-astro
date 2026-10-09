// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// PRIVATE UNEXECUTED owner/storage controls through the actual App and SessionStore.
import { afterEach, expect, it } from 'vitest';
import {
  close,
  closeAll,
  copied,
  CreateServer,
  draftTab,
  inline,
  open,
  retry,
} from './p05-inline-create-support.ts';
afterEach(closeAll);

it('same-owner transport replacement preserves the full held envelope', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Transport retained');
  const first = server.commands('/task/create')[0]!;
  await app.renderFetch((url, init) => server.fetch(url, init));
  await retry(app, String(first.body['operationId']));
  expect(server.commands('/task/create')[1]).toStrictEqual(first);
  expect(server.applied).toHaveLength(1);
});

it('same-owner sessionId rotation plus a fresh realm keeps custody without a bearer', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Session rotation retained');
  const first = server.commands('/task/create')[0]!;
  app.sessions.set({
    businessKey: 'alpha',
    email: 'draft-entry@example.test',
    sessionId: 'rotated-slot',
  });
  const tab = copied(app.storage);
  await close(app);
  const next = await open(server, tab);
  await retry(next, String(first.body['operationId']));
  expect(server.commands('/task/create')[1]).toStrictEqual(first);
  expect(server.applied).toHaveLength(1);
});

it.each(['business', 'person', 'signout'] as const)(
  '%s departure fences a delayed old create and excludes its copy',
  async (kind) => {
    const server = new CreateServer();
    const release = server.hold('/task/create');
    const first = await open(server);
    await inline(first, 'Old owner secret');
    const request = server.commands('/task/create')[0]!;
    if (kind === 'signout') first.sessions.clear();
    else
      first.sessions.set({
        businessKey: kind === 'business' ? 'bravo' : 'alpha',
        email: kind === 'person' ? 'new@example.test' : 'draft-entry@example.test',
      });
    const tab = copied(first.storage);
    await close(first);
    server.person(kind === 'person' ? 'new@example.test' : 'draft-entry@example.test');
    const next = await open(server, tab);
    const readsBefore = server.sent.filter((sent) =>
      ['/task/board', '/task/read'].includes(sent.path),
    ).length;
    await next.act(() => {
      release();
    });
    await next.tick();
    expect(
      server.sent.filter((sent) => ['/task/board', '/task/read'].includes(sent.path)),
    ).toHaveLength(readsBefore);
    expect(next.view.text()).not.toContain('Old owner secret');
    expect(
      next.view.find(`[data-create-retry="${String(request.body['operationId'])}"]`),
    ).toBeNull();
    expect(server.commands('/task/create')).toHaveLength(1);
  },
);

it('storage refusal prevents a new inline dispatch, then a first canonical SCOPE is known', async () => {
  const server = new CreateServer();
  server.denied = true;
  const tab = draftTab();
  const write = tab.setItem.bind(tab);
  let blocked = true;
  tab.setItem = (name, value) => {
    if (blocked && value.includes('Storage blocked create')) throw new Error('quota denied');
    write(name, value);
  };
  const app = await open(server, tab);
  await inline(app, 'Storage blocked create');
  expect(server.commands('/task/create')).toHaveLength(0);
  expect(app.view.text()).toContain('No new task was sent');
  blocked = false;
  await app.view.click('.projects__create button[type="submit"]');
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).not.toContain('may already have been created');
});

it('settled cleanup failure retries only cleanup and preserves a newer unsent title', async () => {
  const server = new CreateServer();
  const tab = draftTab();
  const write = tab.setItem.bind(tab);
  const remove = tab.removeItem.bind(tab);
  let blocked = false;
  tab.setItem = (name, value) => {
    if (blocked && !value.includes('Cleanup first task')) throw new Error('cleanup denied');
    write(name, value);
  };
  tab.removeItem = (name) => {
    if (blocked) throw new Error('cleanup denied');
    remove(name);
  };
  server.afterApplied = () => {
    blocked = true;
  };
  const app = await open(server, tab);
  await inline(app, 'Cleanup first task');
  expect(server.applied).toHaveLength(1);
  expect(app.view.text()).toContain('recovery copy could not be cleared');
  await app.view.type('#create-title', 'Newer unsent title');
  blocked = false;
  await app.view.click('[data-create-cleanup]');
  await app.tick();
  expect(server.commands('/task/create')).toHaveLength(1);
  expect(app.view.find('#create-title')).toHaveProperty('value', 'Newer unsent title');
});

it('failed old-slot removal during A-to-B-to-A cannot restore custody when endings persist', async () => {
  const server = new CreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server);
  await inline(app, 'Departed A secret');
  const first = server.commands('/task/create')[0]!;
  app.storage.removeItem = () => {
    throw new Error('removal denied');
  };
  app.sessions.set({ businessKey: 'bravo', email: 'draft-entry@example.test' });
  app.sessions.set({ businessKey: 'alpha', email: 'draft-entry@example.test' });
  const tab = copied(app.storage);
  await close(app);
  const next = await open(server, tab);
  expect(next.view.find('#create-title')).toHaveProperty('value', '');
  expect(next.view.find('.projects__create')?.textContent).not.toContain('Departed A secret');
  expect(next.view.find(`[data-create-retry="${String(first.body['operationId'])}"]`)).toBeNull();
  expect(server.commands('/task/create')).toHaveLength(1);
});
