// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
// With site data blocked the board keeps its edits in memory, but it checks them exactly as
// it does with tab storage: a task id, a revision to send, and a receipt naming the task.
import { expect, it } from 'vitest';
import { draftTab } from './projects-draft-app-support.tsx';
import { realm } from './task-timer-recovery-support.tsx';
import { BoardEditServer, ROW, TASK, key, rename, retry } from './p05-board-edit-support.ts';
import { OTHER } from './p05-board-edit-server.ts';
import { json } from './p05-assignment-http.ts';

async function blocked(fetch: typeof globalThis.fetch) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1480 });
  return await realm(fetch, draftTab(), '/projects/', null);
}

it('with site data blocked, a receipt for another task keeps the board edit held under its operation', async () => {
  const world = new BoardEditServer('none');
  let forged = false;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const answer = await world.fetch(input, init);
    if (forged || !String(input).endsWith('/task/update')) return answer;
    forged = true;
    return json({ recordId: OTHER, revision: 5, detail: {} });
  };
  const app = await blocked(fetch);
  await rename(app, 'Renamed without storage');
  await key(app, ROW + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes[0]?.body).toMatchObject({ recordId: TASK, expectedRevision: 4 });
  expect(app.view.find(`[data-board-edit-retry="${TASK}"]`)).not.toBeNull();
  expect(app.view.text()).toContain('may already have been applied');
  await retry(app);
  expect(world.writes).toHaveLength(2);
  expect(world.writes[1]).toStrictEqual(world.writes[0]);
  expect(world.applications).toHaveLength(1);
  expect(app.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
  app.view.unmount();
});

it('with site data blocked, a board row without a task id sends no edit', async () => {
  const world = new BoardEditServer('none');
  const loose = 'board-row-without-a-task-id';
  world.row(OTHER).id = loose;
  const app = await blocked(world.fetch);
  const row = `tr[data-row="${loose}"]`;
  const door = app.view.find(row + ' a.cbd__nm');
  if (!(door instanceof HTMLElement)) throw new Error('The board did not show the row');
  await app.act(() =>
    door.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })),
  );
  await app.view.type(row + ' input.cbd__rename', 'Renamed loose row');
  await key(app, row + ' input.cbd__rename', 'Enter');
  await app.tick();
  expect(world.writes).toHaveLength(0);
  app.view.unmount();
});
