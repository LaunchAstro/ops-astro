// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { timerCustody } from '../../apps/web/src/screens/task/task-timer-custody.ts';
import { store } from './draft-support.tsx';

const A = '11111111-1111-4111-8111-111111111111';
const ENTRY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const START = '2026-10-09T01:00:00.000Z';
const owner = 'alpha:ada@example.test:0';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const refusal = () => json({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }, 403);
const flush = async () => {
  for (let n = 0; n < 4; n++)
    // oxlint-disable-next-line no-await-in-loop -- one macrotask at a time
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
};

it('timer recovery stays with its business and person and stores no client metadata', async () => {
  const storage = store();
  const fetch: typeof globalThis.fetch = () => Promise.resolve(refusal());
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const timer = new TaskTimer(client, () => true, timerCustody(storage, owner));
  timer.start({ id: A, title: 'Private task title', key: 'Private-key' });
  await flush();
  expect(timerCustody(storage, 'bravo:ada@example.test:0').restored).toBeNull();
  expect(timerCustody(storage, 'alpha:bea@example.test:0').restored).toBeNull();
  expect(timerCustody(storage, owner).restored?.attempt?.operationId).toBe(
    timer.snapshot().attempt?.operationId,
  );
  expect(storage.getItem('ops-astro.task-timer')).not.toContain('Private');
});

it('a restored known Stop refusal retries under a new id and keeps its entry guard', async () => {
  const storage = store();
  const sent: Record<string, unknown>[] = [];
  const registered = new Set<string>();
  let permitted = false;
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/task/read'))
      return Promise.resolve(
        json({
          ok: true,
          task: {
            id: A,
            key: 'A',
            title: 'A',
            time: { running: { entryId: ENTRY, startedAt: START } },
          },
        }),
      );
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    if (!permitted || registered.has(body.operationId)) {
      registered.add(body.operationId);
      return Promise.resolve(refusal());
    }
    return Promise.resolve(
      json({ recordId: A, revision: 2, detail: { entryId: ENTRY, minutes: 1 } }),
    );
  };
  const client = () =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const timer = new TaskTimer(client(), () => true, timerCustody(storage, owner));
  await timer.read(A, () => true);
  timer.stop();
  await flush();
  expect(timer.snapshot().attempt?.status).toBe('refused');
  const restored = new TaskTimer(client(), () => true, timerCustody(storage, owner));
  expect(restored.snapshot().attempt?.because).not.toContain('checks the current permission');
  permitted = true;
  restored.retry();
  await flush();
  expect(sent[1]?.['operationId']).not.toBe(sent[0]?.['operationId']);
  expect(sent[1]?.['expectedEntryId']).toBe(ENTRY);
  expect(restored.snapshot().attempt).toBeNull();
});

it('letting go of a lost Stop clears the running timer the recovery read found idle', async () => {
  let running = true;
  let stops = 0;
  let reads = 0;
  const fetch: typeof globalThis.fetch = (url) => {
    if (String(url).endsWith('/task/read')) {
      reads++;
      return Promise.resolve(
        json({
          ok: true,
          task: {
            id: A,
            key: 'A',
            title: 'A',
            time: { running: running ? { entryId: ENTRY, startedAt: START } : null },
          },
        }),
      );
    }
    if (String(url).endsWith('/time/stop')) {
      if (++stops === 1) {
        running = false;
        return Promise.reject(new TypeError('committed Stop reply lost'));
      }
      // Current authority withholds the stored success.
      return Promise.resolve(refusal());
    }
    return Promise.resolve(
      json({ recordId: A, revision: 3, detail: { entryId: ENTRY, startedAt: START } }),
    );
  };
  const timer = new TaskTimer(
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    () => true,
  );
  await timer.read(A, () => true);
  timer.stop();
  await flush();
  timer.retry();
  await flush();
  expect(reads).toBe(2);
  expect(timer.snapshot().attempt).toMatchObject({ status: 'unknown', refusal: true });
  timer.dismiss();
  expect(timer.snapshot().attempt).toBeNull();
  expect(
    timer.snapshot().binding,
    'the checked idle timer must replace the stale running binding when letting go',
  ).toBeNull();
});
