// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  DRAFT_KEY,
  OrderedCreateServer,
  close,
  closeAll,
  copied,
  drain,
  file,
  open,
  seeded,
  submit,
} from './p05-draft-create-support.ts';
afterEach(async () => {
  await closeAll();
  vi.restoreAllMocks();
});

it.each(['make-001', `a${'b'.repeat(199)}`])(
  'inline operation identity of length %s remains legal in the shared document',
  async (operationId) => {
    const server = new OrderedCreateServer();
    server.lose('/task/create', 'after');
    const app = await open(server);
    const { OperationsClient } = await import('../../apps/web/src/operations/client.ts');
    vi.spyOn(OperationsClient.prototype, 'newOperationId').mockReturnValue(operationId);
    await app.view.type('#create-title', 'Legal inline recovery');
    await app.view.click('.projects__create button[type="submit"]');
    await drain(app);
    expect(server.commands('/task/create')[0]?.body['operationId']).toBe(operationId);
    const original = server.commands('/task/create')[0]!;
    const tab = copied(app.storage);
    await close(app);
    vi.restoreAllMocks();
    const next = await open(server, tab);
    expect(server.commands('/task/create')).toHaveLength(1);
    await next.view.click(`[data-create-retry="${operationId}"]`);
    await drain(next);
    expect(server.commands('/task/create')).toStrictEqual([original, original]);
    expect(server.applied).toHaveLength(1);
  },
);

it.each([
  { name: 'null title', patch: { title: null } },
  { name: 'null tags', patch: { tags: null } },
  { name: 'null Attempt', patch: { attempt: null } },
  { name: 'primitive Attempt', patch: { attempt: 'malformed' } },
])(
  'malformed current $name is held without an exception, execution or replacement',
  async ({ patch }) => {
    const server = new OrderedCreateServer();
    const storage = seeded({ title: 'Unsent intact words' });
    const original = JSON.parse(storage.getItem(DRAFT_KEY)!) as Record<string, unknown>;
    const raw = JSON.stringify({ ...original, ...patch });
    storage.setItem(DRAFT_KEY, raw);
    const app = await open(server, storage);
    await file(app);
    expect(server.writes()).toHaveLength(0);
    expect(storage.getItem(DRAFT_KEY)).toBe(raw);
    await submit(app);
    expect(server.writes()).toHaveLength(0);
    expect(storage.getItem(DRAFT_KEY)).toBe(raw);
    await close(app);
  },
);

it('a malformed captured lost-after copy does not deny the prior task effect', async () => {
  const server = new OrderedCreateServer();
  server.lose('/task/create', 'after');
  const app = await open(server, seeded({ title: 'Already applied task' }));
  await file(app);
  await submit(app);
  expect(server.applied).toHaveLength(1);
  const tab = copied(app.storage);
  const original = JSON.parse(tab.getItem(DRAFT_KEY)!) as Record<string, unknown>;
  expect(original['attempt']).not.toBeUndefined();
  const raw = JSON.stringify({ ...original, tags: null });
  tab.setItem(DRAFT_KEY, raw);
  await close(app);
  const next = await open(server, tab);
  await file(next);
  await submit(next);
  expect(server.writes()).toHaveLength(1);
  expect(server.applied).toHaveLength(1);
  expect(tab.getItem(DRAFT_KEY)).toBe(raw);
  expect(next.view.find('[data-draft-refusal]')?.textContent).toContain(
    'No recovery request was sent',
  );
  expect(next.view.find('[data-draft-refusal]')?.textContent).not.toContain('no task was sent');
});
