// SPDX-License-Identifier: AGPL-3.0-only
import { expect, onTestFinished } from 'vitest';
import { realm, copied } from './task-timer-recovery-support.tsx';
import { TASK_STAGES } from '../../packages/core-wire/src/index.ts';
import { BoardEditServer, TASK, TITLE } from './p05-board-edit-server.ts';
export { copied, BoardEditServer, TASK, TITLE };
export type App = Awaited<ReturnType<typeof realm>>;
export type Variant = 'title' | 'due' | 'estimate' | 'stage' | 'complete' | 'reopen';
export const SLOT = 'ops-astro.board-edit-attempts';
export const ROW = `tr[data-row="${TASK}"]`;
export async function open(world: BoardEditServer, storage?: Storage, path = '/projects/') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  const app = await realm(world.fetch, storage, path);
  onTestFinished(() => app.view.unmount());
  return app;
}
export async function rename(app: App, text: string) {
  const door = app.view.find(ROW + ' a.cbd__nm');
  if (!(door instanceof HTMLElement)) throw new Error('No admitted row name');
  await app.act(() =>
    door.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })),
  );
  await app.view.type(ROW + ' input.cbd__rename', text);
  return app.view.find(ROW + ' input.cbd__rename');
}
export async function submit(app: App, kind: Variant) {
  if (kind === 'title') {
    await rename(app, 'Submitted title');
    await key(app, ROW + ' input.cbd__rename', 'Enter');
  } else if (kind === 'complete' || kind === 'reopen')
    await app.view.click(ROW + ' input.cbd__tick');
  else await cell(app, kind);
  await app.tick();
}
async function cell(app: App, kind: 'due' | 'estimate' | 'stage') {
  const column = kind;
  const selector = ROW + ` td[data-key="${column}"]`;
  await app.view.click(selector + ' button.cbd__edb');
  if (kind === 'due') {
    await key(app, selector + ' input[type="date"]', '2');
    await app.view.type(selector + ' input[type="date"]', '2026-10-12');
    await key(app, selector + ' input[type="date"]', 'Enter');
  } else {
    const label = kind === 'estimate' ? 'Not set' : TASK_STAGES.list()[0]!.label;
    const choice = app.view
      .all(selector + ' [role="option"]')
      .find((option) => option.textContent === label);
    if (!(choice instanceof HTMLElement)) throw new Error('No canonical cell choice');
    await app.act(() => choice.click());
  }
}
export async function retry(app: App, id = TASK) {
  const selector = `[data-board-edit-retry="${id}"]`;
  expect(
    app.view.find(selector),
    'admitted task must offer its original exact board edit',
  ).not.toBeNull();
  await app.view.click(selector);
  await app.tick();
}
export function held(storage: Storage, operationId: unknown): string {
  const raw = storage.getItem(SLOT);
  expect(raw, 'original complete board edit must be durably kept').not.toBeNull();
  expect(raw).toContain(String(operationId));
  return raw ?? '';
}

export async function key(app: App, selector: string, value: string) {
  const input = app.view.find(selector);
  if (!(input instanceof HTMLElement)) throw new Error('Missing actual keyboard target');
  await app.act(() =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
}
