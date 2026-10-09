// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  open,
  submit,
  retry,
  copied,
  held,
  BoardEditServer,
  TASK,
  ROW,
  rename,
  key,
  type Variant,
} from './p05-board-edit-support.ts';
import { TASK_STAGES } from '../../packages/core-wire/src/index.ts';

it('actual App submitted title survives copied tab hydration without passive send, then retries exact R/op/body once', async () => {
  const world = new BoardEditServer();
  const first = await open(world);
  await submit(first, 'title');
  const original = world.writes[0]!;
  expect(original.body).toMatchObject({
    recordId: TASK,
    expectedRevision: 4,
    fields: { title: 'Submitted title' },
  });
  expect(world.applications).toHaveLength(1);
  held(first.storage, original.body['operationId']);
  world.advance();
  const next = copied(first.storage);
  await first.view.unmount();
  const fresh = await open(world, next);
  expect(world.writes).toHaveLength(1);
  await retry(fresh);
  expect(world.writes).toHaveLength(2);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
  expect(world.row().revision).toBe(6);
});

it.each(['title', 'due', 'estimate', 'stage', 'complete', 'reopen'] satisfies Variant[])(
  'Projects %s freezes its original command/body/revision through explicit lost-answer replay',
  async (kind) => {
    const world = new BoardEditServer();
    if (kind === 'reopen') world.row().completedAt = '2026-10-08T00:00:00Z';
    const app = await open(world);
    await submit(app, kind);
    const original = world.writes[0]!;
    expect(original.body['expectedRevision']).toBe(4);
    expect(original.body['recordId']).toBe(TASK);
    if (kind === 'stage')
      expect(original.body['fields']).toEqual({ stage: TASK_STAGES.list()[0]!.id });
    if (kind === 'estimate') expect(original.body['fields']).toEqual({ estimated_minutes: null });
    if (kind === 'reopen') expect(original.body['reason']).toBe('Reopened from the Projects board');
    world.advance();
    await retry(app);
    expect(world.writes[1]).toStrictEqual(original);
    expect(world.applications).toHaveLength(1);
  },
);

it('never-reached completion retries the same operation and has one application', async () => {
  const world = new BoardEditServer('unreached');
  const app = await open(world);
  await submit(app, 'complete');
  const original = world.writes[0]!;
  expect(world.applications).toHaveLength(0);
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('unknown followed by current-authority withholding retains identity and uncertainty until renewal', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  await submit(app, 'title');
  const original = world.writes[0]!;
  world.denied = true;
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  held(app.storage, original.body['operationId']);
  expect(app.view.find('[data-board-edit-recovery]')?.textContent).toContain('SCOPE_NOT_GRANTED');
  expect(app.view.find('[data-board-edit-recovery]')?.textContent).not.toContain('was not made');
  world.denied = false;
  await retry(app);
  expect(world.writes[2]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('compact Todo completion and board share one task hold across navigation, with no replacement operation', async () => {
  const world = new BoardEditServer();
  const app = await open(world, undefined, '/todos');
  await app.view.click('[data-todo-row="Board-edit-1"] [data-todo-tick]');
  await app.tick();
  const original = world.writes[0]!;
  expect(original.url).toBe('/api/b/alpha/task/complete');
  await app.renderPath('/projects/');
  await app.tick();
  await app.view.click(ROW + ' input.cbd__tick');
  expect(world.writes).toHaveLength(1);
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});

it('a newer blocked rename keeps its exact node/value/caret until the old completion is recovered', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  await submit(app, 'complete');
  const original = world.writes[0]!;
  const editor = await rename(app, 'Independent newer words');
  expect(editor).toBeInstanceOf(HTMLInputElement);
  if (!(editor instanceof HTMLInputElement)) throw new Error('No real rename input');
  editor.focus();
  editor.setSelectionRange(5, 11);
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  expect(app.view.find(ROW + ' input.cbd__rename')).toBe(editor);
  expect(editor.value).toBe('Independent newer words');
  expect(editor.selectionStart).toBe(5);
  expect(editor.selectionEnd).toBe(11);
  expect(world.writes).toHaveLength(1);
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(app.view.find(ROW + ' input.cbd__rename')).toBe(editor);
  expect(editor.value).toBe('Independent newer words');
});

it('due-date null clear is kept verbatim across an unknown answer', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  const cell = ROW + ' td[data-key="due"]';
  await app.view.click(cell + ' button.cbd__edb');
  await key(app, cell + ' input[type="date"]', 'Backspace');
  await app.view.type(cell + ' input[type="date"]', '');
  await key(app, cell + ' input[type="date"]', 'Enter');
  await app.tick();
  const original = world.writes[0]!;
  expect(original.body['fields']).toStrictEqual({ due: null });
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});
it('old complete replay does not repeat a later externally reopened transition', async () => {
  const world = new BoardEditServer();
  const app = await open(world);
  await submit(app, 'complete');
  const original = world.writes[0]!;
  world.row().completedAt = null;
  world.advance();
  await app.renderFetch((input, init) => world.fetch(input, init));
  await app.tick();
  expect(world.writes).toHaveLength(1);
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.row().completedAt).toBeNull();
  expect(world.row().revision).toBe(6);
  expect(world.applications).toHaveLength(1);
});
