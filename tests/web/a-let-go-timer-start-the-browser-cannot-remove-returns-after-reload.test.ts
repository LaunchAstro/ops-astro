// SPDX-License-Identifier: AGPL-3.0-only
//
// When tab storage refuses to remove a let-go timer attempt, the let-go holds
// for this tab, and after a reload the attempt returns held under its own
// operation id: Retry sends that same id, never a new one.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { timerCustody } from '../../apps/web/src/screens/task/task-timer-custody.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { store } from './draft-support.tsx';

const OWNER = 'alpha:ada@example.test:0';
const A = '11111111-1111-4111-8111-11111111111a';
const pause = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0);
  });
const settleMicrotasks = async (): Promise<void> => {
  await pause();
  await pause();
  await pause();
};

/** The first send of each change is lost; every later one is refused; a task read never answers. */
function server() {
  const ids: string[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/task/read')) return new Promise(() => {});
    ids.push(String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId));
    return ids.length === 1
      ? Promise.reject(new TypeError('Failed to fetch'))
      : Promise.resolve(
          new Response(
            JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }),
            { status: 403 },
          ),
        );
  };
  const client = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { ids, client };
}

/** The browser stops accepting writes (setItem) or removals of one key. */
function block(storage: Storage, key: string, method: 'setItem' | 'removeItem'): () => void {
  if (method === 'setItem') {
    const set = storage.setItem.bind(storage);
    storage.setItem = (name, value) => {
      if (name === key) throw new Error('storage blocked');
      set(name, value);
    };
    return () => {
      storage.setItem = set;
    };
  }
  const remove = storage.removeItem.bind(storage);
  storage.removeItem = (name) => {
    if (name === key) throw new Error('storage blocked');
    remove(name);
  };
  return () => {
    storage.removeItem = remove;
  };
}

/** Every request so far went under the one held id. */
const onlyHeld = (ids: readonly string[], heldId: string): void => {
  expect(ids.at(-1)).toBe(heldId);
  expect(new Set(ids).size).toBe(1);
};

it('A let-go timer Start whose saved copy could not be removed returns after a reload under its own id', async () => {
  const world = server();
  const storage = store();
  const timer = new TaskTimer(world.client(), () => true, timerCustody(storage, OWNER));
  timer.start({ id: A });
  await settleMicrotasks();
  timer.retry();
  await settleMicrotasks();
  const heldId = world.ids[0]!;
  const restore = block(storage, 'ops-astro.task-timer', 'removeItem');
  timer.dismiss();
  expect(timer.snapshot().attempt).toMatchObject({ status: 'abandoned' });
  restore();
  const reloaded = new TaskTimer(world.client(), () => true, timerCustody(storage, OWNER));
  expect(reloaded.snapshot().attempt?.operationId).toBe(heldId);
  reloaded.retry();
  await settleMicrotasks();
  onlyHeld(world.ids, heldId);
});
