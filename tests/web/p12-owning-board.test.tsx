// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { keepDraft, emptyDraft } from '../../apps/web/src/screens/task/task-draft.ts';
import { PERSON } from './projects-draft-app-support.tsx';
import {
  boardDoorApp,
  panelOf,
  modified,
  commands,
  boardA,
  KEY,
  ID,
  PAGE_DOOR,
  PANEL_DOOR,
  tick,
} from './p12-board-door-support.tsx';

it.each([
  { board: { readable: true as const, id: boardA, title: 'Current board' }, value: boardA },
  { board: null, value: 'none' },
])('direct task crumb encodes owning destination $value and target', async ({ board, value }) => {
  const app = await boardDoorApp(board);
  expect(app.view.find(PAGE_DOOR)?.getAttribute('href')).toBe(
    `/projects/?board=${value}&target=${KEY}`,
  );
  expect(commands(app.sent)).toEqual([]);
});
it('withheld task crumb has safe words and no unrelated Projects fallback', async () => {
  const app = await boardDoorApp({ readable: false });
  expect(app.view.find(PAGE_DOOR)).toBeNull();
  expect(app.view.text()).toContain('A board you cannot open');
  expect(app.view.text()).not.toContain(boardA);
});
it.each([
  { board: { readable: true as const, id: boardA, title: 'Current board' }, value: boardA },
  { board: null, value: 'none' },
])(
  'panel board door navigates to admitted destination $value and focuses its row',
  async ({ board, value }) => {
    const app = await boardDoorApp(board);
    await panelOf(app);
    expect(app.view.find(PANEL_DOOR)?.getAttribute('href')).toBe(
      `/projects/?board=${value}&target=${KEY}`,
    );
    expect(app.view.find('[data-panel-head="page"]')?.getAttribute('href')).toBe(`/task/${KEY}`);
    await app.view.click(PANEL_DOOR);
    await tick();
    expect(app.sent.findLast((one) => one.path === '/task/board')?.body).toEqual({
      board: value === 'none' ? null : value,
    });
    expect(document.activeElement).toBe(app.view.find(`[data-row="${ID}"] a.cbd__nm`));
    expect(app.view.find('[data-task-panel]')).not.toBeNull();
    expect(commands(app.sent)).toEqual([]);
  },
);
it('panel withholds the board door without publishing any hidden destination', async () => {
  const app = await boardDoorApp({ readable: false });
  await panelOf(app);
  expect(app.view.find(PANEL_DOOR)).toBeNull();
  expect(app.view.find('[data-task-panel]')?.textContent).toContain('A board you cannot open');
  expect(app.view.host.innerHTML).not.toContain(boardA);
});
it.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)(
  '%s panel click leaves ordinary browser navigation and dock state intact',
  async (modifier) => {
    const app = await boardDoorApp();
    await panelOf(app);
    const before = app.sent.filter((one) => one.path === '/task/board').length;
    await modified(app, PANEL_DOOR, modifier);
    expect(app.view.find('.tpr__title')?.textContent).toBe('Admitted target');
    expect(app.view.find('[data-task-panel]')).not.toBeNull();
    expect(app.sent.filter((one) => one.path === '/task/board')).toHaveLength(before);
    expect(commands(app.sent)).toEqual([]);
  },
);
it('a current refused task read removes its old board crumb and panel door', async () => {
  const app = await boardDoorApp();
  await panelOf(app);
  app.state.taskDenied = true;
  await app.reread();
  expect(app.view.find(PAGE_DOOR)).toBeNull();
  expect(app.view.find(PANEL_DOOR)).toBeNull();
  expect(app.view.text()).not.toContain('Current board');
});
it('a new permitted task answer replaces the board destination', async () => {
  const app = await boardDoorApp();
  app.state.board = null;
  await app.reread();
  expect(app.view.find(PAGE_DOOR)?.getAttribute('href')).toBe(
    `/projects/?board=none&target=${KEY}`,
  );
});
it('revoked destination authority never falls back to an aggregate or target lookup', async () => {
  const app = await boardDoorApp();
  app.state.boardDenied = true;
  await app.view.click(PAGE_DOOR);
  await tick();
  expect(app.view.all('[data-row]')).toHaveLength(0);
  expect(app.view.text()).not.toContain('Admitted target');
  expect(
    app.sent
      .filter((one) => one.path === '/task/board')
      .every((one) => one.body['board'] === boardA),
  ).toBe(true);
  expect(app.sent.filter((one) => one.path === '/task/read')).toHaveLength(1);
});
it('a late admitted destination row is focused only after its read arrives', async () => {
  const app = await boardDoorApp();
  app.state.held = true;
  await app.view.click(PAGE_DOOR);
  expect(app.view.all('[data-row]')).toHaveLength(0);
  await app.release();
  expect(document.activeElement).toBe(app.view.find(`[data-row="${ID}"] a.cbd__nm`));
});
it('an absent target performs no extra task lookup or wider board read', async () => {
  const app = await boardDoorApp();
  app.state.targetAbsent = true;
  await app.view.click(PAGE_DOOR);
  await tick();
  expect(app.view.all('[data-row]')).toHaveLength(0);
  expect(app.sent.filter((one) => one.path === '/task/read')).toHaveLength(1);
  expect(
    app.sent
      .filter((one) => one.path === '/task/board')
      .every((one) => one.body['board'] === boardA),
  ).toBe(true);
});
it('panel board navigation preserves its running task timer without Stop', async () => {
  const app = await boardDoorApp();
  app.state.running = true;
  await app.reread();
  await panelOf(app);
  const panel = app.view.find('[data-task-panel]');
  await app.view.click(PANEL_DOOR);
  await tick();
  expect(app.view.find('[data-task-panel]')).toBe(panel);
  expect(commands(app.sent)).toEqual([]);
  expect(app.view.host.querySelector('[data-task-timer-strip]')?.textContent).toContain(
    'Admitted target',
  );
});
it('panel board navigation keeps its independent unsent comment text', async () => {
  const app = await boardDoorApp();
  await panelOf(app);
  const input = app.view.find('[data-task-panel] textarea');
  expect(input).not.toBeNull();
  await app.view.type('[data-task-panel] textarea', 'Kept independent words');
  await app.view.click(PANEL_DOOR);
  await tick();
  expect(app.view.find('[data-task-panel] textarea')).toBe(input);
  expect(input instanceof HTMLTextAreaElement ? input.value : null).toBe('Kept independent words');
  expect(commands(app.sent)).toEqual([]);
});
it('board navigation preserves an existing kept draft and canonical copy address', async () => {
  const app = await boardDoorApp();
  keepDraft(app.storage, PERSON, { ...emptyDraft(null), title: 'Kept draft' });
  const write = vi.fn(async () => {});
  const old = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: write },
  });
  try {
    await app.view.click('[data-copy="address"]');
    expect(write).toHaveBeenCalledWith(`${window.location.origin}/task/${KEY}`);
    await panelOf(app);
    await app.view.click(PANEL_DOOR);
    await tick();
    await app.view.click('[data-panel-head="new"]');
    await act(async () => {
      await Promise.resolve();
    });
    expect(app.view.host.querySelector<HTMLInputElement>('#panel-draft-name')?.value).toBe(
      'Kept draft',
    );
    expect(commands(app.sent)).toEqual([]);
  } finally {
    if (old === undefined) Reflect.deleteProperty(navigator, 'clipboard');
    else Object.defineProperty(navigator, 'clipboard', old);
  }
});
