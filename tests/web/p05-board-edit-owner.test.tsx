// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { expect, it } from 'vitest';
import {
  open,
  submit,
  retry,
  copied,
  held,
  SLOT,
  TASK,
  TITLE,
  BoardEditServer,
} from './p05-board-edit-support.ts';
import { json } from './p05-assignment-http.ts';
function uninitialised(): never {
  throw new Error('Deferred uninitialised');
}
function delayed() {
  let release: (answer: Response) => void = uninitialised;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
it('same-owner transport renewal ignores a late old answer and keeps exact explicit replay', async () => {
  const world = new BoardEditServer('none');
  const answer = delayed();
  world.deferWrite = answer.promise;
  const app = await open(world);
  await submit(app, 'title');
  const original = world.writes[0]!;
  const raw = held(app.storage, original.body['operationId']);
  await app.renderFetch((input, init) => world.fetch(input, init));
  await app.act(() => answer.release(json({ recordId: TASK, revision: 5, detail: {} })));
  await app.tick();
  expect(app.storage.getItem(SLOT)).toBe(raw);
  expect(world.writes).toHaveLength(1);
  await retry(app);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});
it.each(['business', 'person', 'signout'] as const)(
  '%s departure excludes prior-owner attempt even if a late answer returns',
  async (kind) => {
    const world = new BoardEditServer('none');
    const answer = delayed();
    world.deferWrite = answer.promise;
    const first = await open(world);
    await submit(first, 'title');
    if (kind === 'signout') first.sessions.clear();
    else
      first.sessions.set({
        businessKey: kind === 'business' ? 'beta' : 'alpha',
        email: kind === 'person' ? 'other@example.test' : 'draft-entry@example.test',
      });
    const tab = copied(first.storage);
    await first.view.unmount();
    const fresh = await open(world, tab);
    const raw = tab.getItem(SLOT);
    await fresh.act(() => answer.release(json({ recordId: TASK, revision: 5, detail: {} })));
    await fresh.tick();
    expect(tab.getItem(SLOT)).toBe(raw);
    expect(fresh.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
    expect(world.writes).toHaveLength(1);
  },
);
it('board denial withdraws protected recovery labels but leaves exact custody for admitted return', async () => {
  const world = new BoardEditServer();
  const first = await open(world);
  await submit(first, 'title');
  const original = world.writes[0]!;
  const tab = copied(first.storage);
  await first.view.unmount();
  world.readDenied = true;
  const next = await open(world, tab);
  expect(next.view.find('[data-board-edit-recovery]')).toBeNull();
  expect(next.view.text()).not.toContain('Submitted title');
  expect(next.view.text()).not.toContain(TITLE);
  expect(world.writes).toHaveLength(1);
  held(tab, original.body['operationId']);
  world.readDenied = false;
  await next.view.unmount();
  const returned = await open(world, copied(tab));
  await retry(returned);
  expect(world.writes[1]).toStrictEqual(original);
  expect(world.applications).toHaveLength(1);
});
it('failed removal on A-to-B-to-A cannot rehydrate old custody when session endings persisted', async () => {
  const world = new BoardEditServer();
  const first = await open(world);
  await submit(first, 'title');
  first.storage.removeItem = () => {
    throw new Error('Removal refused');
  };
  first.sessions.set({ businessKey: 'beta', email: 'draft-entry@example.test' });
  first.sessions.set({ businessKey: 'alpha', email: 'draft-entry@example.test' });
  const tab = copied(first.storage);
  await first.view.unmount();
  const returned = await open(world, tab);
  expect(returned.view.find(`[data-board-edit-retry="${TASK}"]`)).toBeNull();
  expect(world.writes).toHaveLength(1);
});
