// SPDX-License-Identifier: AGPL-3.0-only
//
// Stop waiting on the timer is the one way a held Start or Stop whose outcome
// is unknown is let go: it does nothing while a retry is in flight, and a
// retry answered with a stored success leaves no id behind. Answers are held
// back and released by hand, so the order of each race is the test's choice.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { timerCustody } from '../../apps/web/src/screens/task/task-timer-custody.ts';
import { TaskTimer } from '../../apps/web/src/screens/task/task-timer.ts';
import { store } from './draft-support.tsx';

const OWNER = 'alpha:ada@example.test:0';
const A = '11111111-1111-4111-8111-11111111111a';
const PERSON = '22222222-2222-4222-8222-222222222222';
const TIMER = 'ops-astro.task-timer';

interface Call {
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly answer: (reply: Response | Error) => Promise<void>;
}

const pause = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0);
  });
const settleMicrotasks = async (): Promise<void> => {
  await pause();
  await pause();
  await pause();
};

/** Every request waits until the test answers it: a Response, or an Error for a lost answer. */
function held() {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (url, init) =>
    new Promise((resolve, reject) => {
      // A task read is never answered: the calls are the timer's commands.
      if (String(url).endsWith('/task/read')) return;
      calls.push({
        path: String(url).replace(/^.*?(\/[a-z]+\/[a-z_]+)$/u, '$1'),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        answer: async (reply) => {
          if (reply instanceof Error) reject(reply);
          else resolve(reply);
          await settleMicrotasks();
        },
      });
    });
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const ids = (): string[] => calls.map((call) => String(call.body['operationId']));
  return { calls, client, ids };
}

const lost = (): Error => new TypeError('Failed to fetch');
const refused = (code: string): Response =>
  new Response(JSON.stringify({ refused: true, code, names: [], fixes: [] }), { status: 409 });
it('Stop waiting on the timer does nothing while its retry is in flight, then lets go of the refused unknown', async () => {
  const server = held();
  const storage = store();
  const timer = new TaskTimer(server.client, () => true, timerCustody(storage, OWNER));
  timer.start({ id: A });
  await server.calls[0]?.answer(lost());
  const heldId = server.ids()[0]!;
  timer.retry();
  expect(server.ids()[1]).toBe(heldId);
  timer.dismiss();
  timer.retry();
  expect(timer.snapshot().attempt).toMatchObject({ status: 'pending', operationId: heldId });
  expect(server.calls).toHaveLength(2);
  await server.calls[1]?.answer(refused('TRANSITION_NOT_PERMITTED'));
  expect(timer.snapshot().attempt).toMatchObject({ status: 'unknown', operationId: heldId });
  timer.dismiss();
  timer.dismiss();
  expect(timer.snapshot().attempt).toBeNull();
  expect(storage.getItem(TIMER)).toBeNull();
  timer.retry();
  expect(server.calls).toHaveLength(2);
  timer.start({ id: A });
  expect(server.ids()[2]).not.toBe(heldId);
});

it('A lost timer Start whose retry finds it stored settles and leaves no id for Stop waiting', async () => {
  const server = held();
  const storage = store();
  const timer = new TaskTimer(server.client, () => true, timerCustody(storage, OWNER));
  timer.start({ id: A });
  await server.calls[0]?.answer(lost());
  timer.retry();
  await server.calls[1]?.answer(
    new Response(
      JSON.stringify({
        recordId: A,
        revision: 5,
        detail: { entryId: PERSON, startedAt: '2026-10-13T00:00:00.000Z' },
      }),
    ),
  );
  expect(timer.snapshot().attempt).toBeNull();
  expect(timer.snapshot().binding?.running?.entryId).toBe(PERSON);
  timer.dismiss();
  timer.retry();
  expect(server.calls).toHaveLength(2);
});
