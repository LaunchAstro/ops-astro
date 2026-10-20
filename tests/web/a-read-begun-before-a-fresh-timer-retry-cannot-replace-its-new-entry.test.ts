// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';

const A = '11111111-1111-4111-8111-111111111111';
const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const START = '2026-10-09T01:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = () =>
  json({ refused: true, code: 'TRANSITION_NOT_PERMITTED', names: [], fixes: [] }, 409);
const applied = (command: string, entryId = NEW) =>
  json({
    recordId: A,
    revision: 2,
    detail: command === 'time.start' ? { entryId, startedAt: START } : { entryId, minutes: 1 },
  });
const readReply = (entryId: string | null) =>
  json({
    ok: true,
    task: {
      id: A,
      key: 'A',
      title: 'Task A',
      time: { running: entryId === null ? null : { entryId, startedAt: START } },
    },
  });
const pause = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0);
  });
const flush = async (): Promise<void> => {
  await pause();
  await pause();
  await pause();
};

it('a read begun before a fresh Retry cannot replace its new running entry', async () => {
  let answerRead!: (response: Response) => void;
  let answerStart!: (response: Response) => void;
  let firstId: string | undefined;
  let freshApplied = false;
  const fetch: typeof globalThis.fetch = (url, init) => {
    if (String(url).endsWith('/task/read'))
      return new Promise((resolve) => {
        answerRead = resolve;
      });
    const id = JSON.parse(String(init?.body)).operationId;
    if (firstId === undefined) {
      firstId = id;
      return Promise.resolve(refused());
    }
    // The real envelope replays the refusal, without running the handler.
    if (id === firstId) return Promise.resolve(refused());
    freshApplied = true;
    return new Promise((resolve) => {
      answerStart = resolve;
    });
  };
  const timer = new TaskTimer(
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    () => true,
  );
  timer.start({ id: A });
  await flush();
  // This request captured the other tab's running entry before it stopped it.
  const reading = timer.read(A, () => true);
  timer.retry();
  await flush();
  // Retry has now committed a different entry; its response is slower than the old read.
  answerRead(readReply(OLD));
  await reading;
  if (freshApplied) {
    answerStart(applied('time.start', NEW));
    await flush();
    expect(timer.snapshot().attempt).toBeNull();
    expect(
      timer.snapshot().binding?.running?.entryId,
      'the successful fresh Start must retain its own entry, not the pre-Retry read',
    ).toBe(NEW);
  } else {
    // On the merge base, Retry is only a refusal replay and creates no new entry.
    expect(timer.snapshot().attempt?.status).toBe('refused');
  }
});
