// SPDX-License-Identifier: AGPL-3.0-only
//
// Stop waiting when the browser cannot rewrite the saved copy leaves the change
// let go but its copy in place, with one control: Clear saved copy. If the tab
// is reloaded before that control succeeds, the let-go change must not come
// back as a held attempt that Retry or Send would replay under its old id.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';
import { CommentCustody } from '../../apps/web/src/screens/task/comment-custody.ts';
import { ScoresCustody } from '../../apps/web/src/screens/task/scores-custody.ts';
import { timerCustody } from '../../apps/web/src/screens/task/task-timer-custody.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { store } from './draft-support.tsx';

const OWNER = 'alpha:ada@example.test:0';
const A = '11111111-1111-4111-8111-11111111111a';
const PERSON = '22222222-2222-4222-8222-222222222222';

const pause = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0);
  });
const settleMicrotasks = async (): Promise<void> => {
  await pause();
  await pause();
  await pause();
};

/** The first send of each change is lost; every later one is refused. */
function server() {
  const ids: string[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
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
function block(storage: Storage, key: string, method: 'setItem' | 'removeItem'): void {
  if (method === 'setItem') {
    const set = storage.setItem.bind(storage);
    storage.setItem = (name, value) => {
      if (name === key) throw new Error('storage blocked');
      set(name, value);
    };
  } else {
    const remove = storage.removeItem.bind(storage);
    storage.removeItem = (name) => {
      if (name === key) throw new Error('storage blocked');
      remove(name);
    };
  }
}

it('A let-go score edit whose saved copy could not be rewritten is not held again after reload', async () => {
  const world = server();
  const storage = store();
  const custody = new ScoresCustody(world.client(), OWNER, storage);
  custody.choose(A, 4, 'impact', 10);
  await settleMicrotasks();
  custody.retry(A);
  await settleMicrotasks();
  const heldId = world.ids[0]!;
  expect(custody.snapshot(A)).toMatchObject({ uncertain: true });
  block(storage, 'ops-astro.task-scores', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, abandoned: true });
  const reloaded = new ScoresCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot(A).pending?.operationId).not.toBe(heldId);
});

it('A let-go assignment whose saved copy could not be rewritten is not held again after reload', async () => {
  const world = server();
  const storage = store();
  const custody = new AssignmentCustody(world.client(), OWNER, storage);
  await custody.choose(A, 4, { assignee: PERSON });
  await custody.retry(A);
  const heldId = world.ids[0]!;
  block(storage, 'ops-astro.assignment-attempts', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot().holds.get(A)).toMatchObject({ pending: null, abandoned: true });
  const reloaded = new AssignmentCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot().holds.get(A)?.pending?.operationId).not.toBe(heldId);
});

it('A let-go comment whose saved copy could not be rewritten is not held again after reload', async () => {
  const world = server();
  const storage = store();
  const custody = new CommentCustody(world.client(), OWNER, storage);
  const words = {
    operationId: '33333333-3333-4333-8333-333333333333',
    revision: 4,
    body: 'Words',
    audience: 'internal',
    kind: 'note',
    parentId: null,
  };
  await custody.post(A, words);
  await custody.post(A, words);
  const heldId = world.ids[0]!;
  expect(custody.snapshot(A)).toMatchObject({ uncertain: true });
  block(storage, 'ops-astro.comment-attempts', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, kept: false, answered: 'abandoned' });
  const reloaded = new CommentCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot(A).pending?.operationId).not.toBe(heldId);
});

it('A let-go timer Start whose saved copy could not be removed is not held again after reload', async () => {
  const world = server();
  const storage = store();
  const timer = new TaskTimer(world.client(), () => true, timerCustody(storage, OWNER));
  timer.start({ id: A });
  await settleMicrotasks();
  timer.retry();
  await settleMicrotasks();
  const heldId = world.ids[0]!;
  block(storage, 'ops-astro.task-timer', 'removeItem');
  timer.dismiss();
  expect(timer.snapshot().attempt).toMatchObject({ status: 'abandoned' });
  const reloaded = new TaskTimer(world.client(), () => true, timerCustody(storage, OWNER));
  expect(reloaded.snapshot().attempt?.operationId).not.toBe(heldId);
});
