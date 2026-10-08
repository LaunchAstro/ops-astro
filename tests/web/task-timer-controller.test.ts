// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { task } from './task-page-stub.tsx';

const noRelease = (_answer: Response): void => {};
const ID = '11111111-1111-4111-8111-111111111111';
const START = '2026-10-09T01:00:00.000Z';
const ref = { id: ID, key: 'Timer-A', title: 'Alpha work' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const started = () =>
  json({ recordId: null, revision: null, detail: { entryId: 'entry-a', startedAt: START } });
const stopped = () =>
  json({ recordId: null, revision: null, detail: { entryId: 'entry-a', minutes: 1 } });
const found = (entryId: string | null) =>
  json({
    ok: true,
    task: task({
      ...ref,
      time: {
        entries: [],
        totalMinutes: 0,
        running: entryId === null ? null : { entryId, startedAt: START },
      },
    }),
  });
const denied = () => json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404);
const flush = async () => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
};
function controller(fetch: typeof globalThis.fetch) {
  return new TaskTimer(
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    () => true,
  );
}

it('a read started before Start cannot erase the successful binding with its old idle answer', async () => {
  let release = noRelease;
  const timer = controller((url) =>
    String(url).endsWith('/read')
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(started()),
  );
  const reading = timer.read('Timer-A', () => true);
  timer.start(ref);
  await flush();
  release(found(null));
  await reading;
  expect(timer.snapshot().binding?.running?.entryId).toBe('entry-a');
});

it('a read that lost its route lifetime cannot bind an old task', async () => {
  let release = noRelease;
  let current = true;
  const timer = controller(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  const reading = timer.read('Timer-A', () => current);
  current = false;
  release(found('entry-a'));
  await reading;
  expect(timer.snapshot().binding).toBeNull();
});

it('task read revocation hides metadata but keeps the exact UUID for safe own Stop', async () => {
  const writes: Record<string, unknown>[] = [];
  const timer = controller((url, init) => {
    if (String(url).endsWith('/read')) return Promise.resolve(denied());
    writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Promise.resolve(String(url).endsWith('/start') ? started() : stopped());
  });
  timer.start(ref);
  await flush();
  await timer.read('Timer-A', () => true);
  expect(timer.snapshot().binding?.task).toEqual({ id: ID });
  timer.stop();
  await flush();
  expect(writes.map((one) => one['taskId'])).toEqual([ID, ID]);
  expect(timer.snapshot().binding).toBeNull();
});

it('read denial during pending Start cannot restore the removed task label on settlement', async () => {
  let release = noRelease;
  const timer = controller((url) =>
    String(url).endsWith('/read')
      ? Promise.resolve(denied())
      : new Promise<Response>((resolve) => {
          release = resolve;
        }),
  );
  timer.start(ref);
  await timer.read('Timer-A', () => true);
  release(started());
  await flush();
  expect(timer.snapshot().binding?.task).toEqual({ id: ID });
});

it('an old Stop settlement cannot clear a newer running entry on the same task', async () => {
  let release = noRelease;
  const timer = controller((url) => {
    if (String(url).endsWith('/start')) return Promise.resolve(started());
    if (String(url).endsWith('/read')) return Promise.resolve(found('entry-new'));
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  timer.start(ref);
  await flush();
  timer.stop();
  await timer.read('Timer-A', () => true);
  release(stopped());
  await flush();
  expect(timer.snapshot().binding?.running?.entryId).toBe('entry-new');
  expect(timer.snapshot().attempt).toBeNull();
});

it('double Start and repeated scoped close send only one pending command per intent', async () => {
  const writes: string[] = [];
  let release = noRelease;
  const timer = controller((url) => {
    writes.push(String(url));
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  timer.start(ref);
  timer.start(ref);
  expect(writes).toHaveLength(1);
  release(started());
  await flush();
  timer.stop(ID);
  timer.stop(ID);
  expect(writes).toHaveLength(2);
  release(stopped());
  await flush();
});

it('a task read without time authority cannot declare the known clock idle', async () => {
  const timer = controller((url) =>
    String(url).endsWith('/read')
      ? Promise.resolve(json({ ok: true, task: task({ ...ref, time: null }) }))
      : Promise.resolve(started()),
  );
  timer.start(ref);
  await flush();
  await timer.read('Timer-A', () => true);
  expect(timer.snapshot().binding?.running?.entryId).toBe('entry-a');
});

it('Stop freezes the running entry operand before transport and preserves it on retry', async () => {
  const writes: Record<string, unknown>[] = [];
  const timer = controller((url, init) => {
    if (String(url).endsWith('/read')) return Promise.resolve(found('entry-new'));
    writes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (String(url).endsWith('/start')) return Promise.resolve(started());
    return Promise.reject(new Error('request lost before registration'));
  });
  timer.start(ref);
  await flush();
  timer.stop();
  await flush();
  expect(timer.snapshot().attempt?.payload).toEqual({ taskId: ID, expectedEntryId: 'entry-a' });
  expect(Object.isFrozen(timer.snapshot().attempt?.payload)).toBe(true);
  await timer.read('Timer-A', () => true);
  timer.retry();
  await flush();
  expect(writes[1]).toEqual(writes[2]);
  expect(writes[2]?.['expectedEntryId']).toBe('entry-a');
  expect(timer.snapshot().binding?.running?.entryId).toBe('entry-new');
});

it('a Start receipt without entry identity cannot dispatch a new task-only Stop', async () => {
  const writes: string[] = [];
  const timer = controller((url) => {
    writes.push(String(url));
    return Promise.resolve(json({ recordId: null, revision: null, detail: {} }));
  });
  timer.start(ref);
  await flush();
  expect(timer.snapshot().binding?.running).toBeNull();
  timer.stop();
  await flush();
  expect(writes).toHaveLength(1);
  expect(timer.snapshot().attempt).toBeNull();
});
