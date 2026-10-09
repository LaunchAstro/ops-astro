// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import {
  open,
  submit,
  retry,
  copied,
  held,
  SLOT,
  TASK,
  ROW,
  rename,
  key,
  BoardEditServer,
} from './p05-board-edit-support.ts';
function corrupt(raw: string, variant: string): string {
  if (variant === 'truncated') return '{';
  if (variant === 'array') return '[]';
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const tasks = parsed['tasks'] as Record<string, Record<string, unknown>>;
  const entry = tasks[TASK]!;
  const attempt = entry['attempt'] as Record<string, unknown>;
  if (variant === 'foreign-owner') return JSON.stringify({ ...parsed, owner: 'beta:foreign:0' });
  if (variant === 'prepared') entry['knowledge'] = 'prepared';
  if (variant === 'extra-field') attempt['newAuthority'] = true;
  if (variant === 'bad-operation') attempt['operationId'] = '.original.0';
  if (variant === 'unsupported-command') attempt['command'] = 'task.assign';
  if (variant === 'wrong-revision') attempt['expectedRevision'] = -1;
  return JSON.stringify(parsed);
}
it.each([
  'truncated',
  'array',
  'foreign-owner',
  'prepared',
  'extra-field',
  'bad-operation',
  'unsupported-command',
  'wrong-revision',
])('actual App withholds %s journal and cannot replace its unknown bytes', async (variant) => {
  const world = new BoardEditServer();
  const first = await open(world);
  await submit(first, 'title');
  const original = world.writes[0]!;
  const raw = corrupt(held(first.storage, original.body['operationId']), variant);
  const tab = copied(first.storage);
  tab.setItem(SLOT, raw);
  await first.view.unmount();
  const fresh = await open(world, tab);
  expect(world.writes).toHaveLength(1);
  expect(fresh.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
  expect(fresh.view.text()).toContain('could not be recovered');
  await rename(fresh, 'New blocked title');
  await key(fresh, ROW + ' input.cbd__rename', 'Enter');
  expect(world.writes).toHaveLength(1);
  expect(tab.getItem(SLOT)).toBe(raw);
  expect(world.applications).toHaveLength(1);
});
it('first failed save sends nothing and its retry is fresh rather than potentially applied', async () => {
  const world = new BoardEditServer('none');
  world.denied = true;
  const tab = draftTab();
  const write = tab.setItem.bind(tab);
  let blocked = true;
  tab.setItem = (name, value) => {
    if (name === SLOT && blocked) throw new Error('No durable copy');
    write(name, value);
  };
  const app = await open(world, tab);
  await submit(app, 'title');
  expect(world.writes).toHaveLength(0);
  expect(app.view.text()).toContain('No new change was sent');
  blocked = false;
  await retry(app);
  expect(world.writes).toHaveLength(1);
  expect(app.view.text()).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.text()).not.toContain('may already have been applied');
});
it('exact retained readback permits same-op retry even when setter throws, then cleanup alone retries', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  await submit(app, 'title');
  const original = world.writes[0]!;
  const raw = held(app.storage, original.body['operationId']);
  const write = app.storage.setItem.bind(app.storage);
  let blocked = true;
  app.storage.setItem = (name, value) => {
    if (name === SLOT && blocked) throw new Error('Setter throws but original retained');
    write(name, value);
  };
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
  expect(app.storage.getItem(SLOT)).toBe(raw);
  await retry(app);
  expect(world.writes).toHaveLength(2);
  blocked = false;
  await retry(app);
  expect(world.writes).toHaveLength(2);
  expect(app.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
});
it('unreadable readback and blocked retry retain prior uncertainty without claiming no original send', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  await submit(app, 'title');
  const original = world.writes[0]!;
  const raw = held(app.storage, original.body['operationId']);
  const read = app.storage.getItem.bind(app.storage);
  const write = app.storage.setItem.bind(app.storage);
  let blocked = true;
  app.storage.getItem = (name) => (name === SLOT && blocked ? '{' : read(name));
  app.storage.setItem = (name, value) => {
    if (name === SLOT && blocked) throw new Error('Write refused');
    write(name, value);
  };
  await retry(app);
  expect(world.writes).toHaveLength(1);
  expect(read(SLOT)).toBe(raw);
  expect(app.view.text()).toContain('No retry was sent');
  expect(app.view.text()).not.toContain('No change was sent');
  blocked = false;
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('a canonical non-UUID operation survives unsent storage refusal, lost answer, copied reload and exact Retry', async () => {
  const world = new BoardEditServer();
  const tab = draftTab();
  const write = tab.setItem.bind(tab);
  let blocked = true;
  tab.setItem = (name, value) => {
    if (name === SLOT && blocked) throw new Error('No durable copy');
    write(name, value);
  };
  const first = await open(world, tab);
  const { OperationsClient } = await import('../../apps/web/src/operations/client.ts');
  const mint = vi
    .spyOn(OperationsClient.prototype, 'newOperationId')
    .mockReturnValue('board.edit:canonical-01');
  await submit(first, 'title');
  mint.mockRestore();
  expect(world.writes).toHaveLength(0);
  expect(first.view.text()).toContain('No new change was sent');
  blocked = false;
  await retry(first);
  const original = world.writes[0]!;
  expect(original.body['operationId']).toBe('board.edit:canonical-01');
  held(tab, original.body['operationId']);
  const next = copied(tab);
  await first.view.unmount();
  const fresh = await open(world, next);
  expect(world.writes).toHaveLength(1);
  await retry(fresh);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});
