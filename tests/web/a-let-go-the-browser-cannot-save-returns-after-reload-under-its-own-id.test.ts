// SPDX-License-Identifier: AGPL-3.0-only
//
// Stop waiting when the browser cannot rewrite the saved copy leaves the change
// let go in this tab, its copy in place, with one control: Clear saved copy.
// That is the design's stated limit: nothing can record the let-go across a
// reload, so after one the attempt returns as it was before Stop waiting, held
// under its own operation id, and Retry sends that same id (the server replays
// it; it never makes a second change).
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';
import { CommentCustody } from '../../apps/web/src/screens/task/comment-custody.ts';
import { ScoresCustody } from '../../apps/web/src/screens/task/scores-custody.ts';
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

it('A let-go score edit whose saved copy could not be rewritten returns after a reload under its own id', async () => {
  const world = server();
  const storage = store();
  const custody = new ScoresCustody(world.client(), OWNER, storage);
  custody.choose(A, 4, 'impact', 10);
  await settleMicrotasks();
  custody.retry(A);
  await settleMicrotasks();
  const heldId = world.ids[0]!;
  expect(custody.snapshot(A)).toMatchObject({ uncertain: true });
  const restore = block(storage, 'ops-astro.task-scores', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, abandoned: true });
  restore();
  const reloaded = new ScoresCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot(A).pending?.operationId).toBe(heldId);
  reloaded.retry(A);
  await settleMicrotasks();
  onlyHeld(world.ids, heldId);
});

it('A let-go assignment whose saved copy could not be rewritten returns after a reload under its own id', async () => {
  const world = server();
  const storage = store();
  const custody = new AssignmentCustody(world.client(), OWNER, storage);
  await custody.choose(A, 4, { assignee: PERSON });
  await custody.retry(A);
  const heldId = world.ids[0]!;
  const restore = block(storage, 'ops-astro.assignment-attempts', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot().holds.get(A)).toMatchObject({ pending: null, abandoned: true });
  restore();
  const reloaded = new AssignmentCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot().holds.get(A)?.pending?.operationId).toBe(heldId);
  await reloaded.retry(A);
  onlyHeld(world.ids, heldId);
});

it('A let-go comment whose saved copy could not be rewritten returns after a reload under its own id', async () => {
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
  const restore = block(storage, 'ops-astro.comment-attempts', 'setItem');
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, kept: false, answered: 'abandoned' });
  restore();
  const reloaded = new CommentCustody(world.client(), OWNER, storage);
  expect(reloaded.snapshot(A).pending?.operationId).toBe(heldId);
  await reloaded.post(A, words);
  onlyHeld(world.ids, heldId);
});
