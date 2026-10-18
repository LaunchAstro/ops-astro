// SPDX-License-Identifier: AGPL-3.0-only
//
// Stop waiting is the one way a held change whose outcome is unknown is let go.
// It names the held attempt by its operation id, does nothing while a retry is
// in flight, does nothing twice, and keeps every other task's hold. A retry
// answered with a known outcome leaves no held id behind, and the next change
// is a new request. Answers here are held back and released by hand, so the
// order of each race is the test's choice.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';
import { CommentCustody } from '../../apps/web/src/screens/task/comment-custody.ts';
import { ScoresCustody } from '../../apps/web/src/screens/task/scores-custody.ts';
import { store } from './draft-support.tsx';

const OWNER = 'alpha:ada@example.test:0';
const A = '11111111-1111-4111-8111-11111111111a';
const B = '11111111-1111-4111-8111-11111111111b';
const PERSON = '22222222-2222-4222-8222-222222222222';
const SCORES = 'ops-astro.task-scores';
const ASSIGNMENTS = 'ops-astro.assignment-attempts';
const COMMENTS = 'ops-astro.comment-attempts';
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
const ok = (recordId = A): Response =>
  new Response(JSON.stringify({ recordId, revision: 5, detail: {} }), {
    headers: { 'content-type': 'application/json' },
  });
const refused = (code: string): Response =>
  new Response(JSON.stringify({ refused: true, code, names: [], fixes: [] }), { status: 409 });

const words = (operationId: string) => ({
  operationId,
  revision: 4,
  body: 'Words',
  audience: 'internal',
  kind: 'note',
  parentId: null,
});

const tasksIn = (storage: Storage, key: string): Record<string, unknown> =>
  (JSON.parse(storage.getItem(key) ?? '{"tasks":{}}') as { tasks: Record<string, unknown> }).tasks;

it('Stop waiting on a held score edit is a no-op mid-retry, by a wrong id, or twice, and keeps the other task', async () => {
  const server = held();
  const storage = store();
  const custody = new ScoresCustody(server.client, OWNER, storage);
  custody.choose(A, 4, 'impact', 10);
  custody.choose(B, 4, 'ease', 3);
  await server.calls[0]?.answer(lost());
  await server.calls[1]?.answer(lost());
  const heldId = server.ids()[0]!;
  const sibling = JSON.stringify(tasksIn(storage, SCORES)[B]);
  custody.retry(A);
  expect(server.ids()[2]).toBe(heldId);
  // Two at once: Stop waiting while the retry is in flight does nothing.
  custody.letGo(A, heldId);
  expect(custody.snapshot(A).pending?.operationId).toBe(heldId);
  await server.calls[2]?.answer(refused('VALIDATION_FAILED'));
  expect(custody.snapshot(A)).toMatchObject({ uncertain: true, busy: false });
  custody.letGo(A, heldId.toUpperCase());
  custody.letGo(A, server.ids()[1]!);
  expect(custody.snapshot(A).pending?.operationId).toBe(heldId);
  custody.letGo(A, heldId);
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, kept: true, abandoned: false });
  expect(storage.getItem(SCORES)).not.toContain(heldId);
  expect(JSON.stringify(tasksIn(storage, SCORES)[B])).toBe(sibling);
  custody.retry(A);
  expect(server.calls).toHaveLength(3);
  custody.choose(A, 4, 'impact', 10);
  expect(server.calls).toHaveLength(4);
  expect(server.ids()[3]).not.toBe(heldId);
});

it('A lost score edit whose retry finds it stored settles, leaving no held id to let go or replay', async () => {
  const server = held();
  const storage = store();
  const custody = new ScoresCustody(server.client, OWNER, storage);
  custody.choose(A, 4, 'impact', 10);
  await server.calls[0]?.answer(lost());
  const heldId = server.ids()[0]!;
  custody.retry(A);
  await server.calls[1]?.answer(ok());
  expect(custody.snapshot(A)).toMatchObject({ pending: null, uncertain: false, changed: 1 });
  custody.letGo(A, heldId);
  custody.retry(A);
  expect(server.calls).toHaveLength(2);
  expect(storage.getItem(SCORES)).not.toContain(heldId);
});

it('Stop waiting on an assignment is a no-op while its retry is in flight; that retry answer decides', async () => {
  const server = held();
  const storage = store();
  const custody = new AssignmentCustody(server.client, OWNER, storage);
  void custody.choose(A, 4, { assignee: PERSON });
  await settleMicrotasks();
  await server.calls[0]?.answer(lost());
  const heldId = server.ids()[0]!;
  void custody.retry(A);
  await settleMicrotasks();
  expect(server.ids()[1]).toBe(heldId);
  custody.letGo(A, heldId);
  expect(custody.snapshot().holds.get(A)?.pending?.operationId).toBe(heldId);
  // The server stored the first send; the retry replays that success.
  await server.calls[1]?.answer(ok());
  expect(custody.snapshot().holds.get(A)).toMatchObject({ pending: null, failure: null });
  expect(custody.snapshot().changed).toBeGreaterThan(0);
  custody.letGo(A, heldId);
  await custody.retry(A);
  expect(server.calls).toHaveLength(2);
  expect(storage.getItem(ASSIGNMENTS)).not.toContain(heldId);
});

it('Stop waiting on an assignment refused after a lost answer lets go once and keeps the other task', async () => {
  const server = held();
  const storage = store();
  const custody = new AssignmentCustody(server.client, OWNER, storage);
  void custody.choose(A, 4, { assignee: PERSON });
  void custody.choose(B, 4, { assignee: PERSON });
  await settleMicrotasks();
  await server.calls[0]?.answer(lost());
  await server.calls[1]?.answer(lost());
  const heldId = server.ids()[0]!;
  const sibling = JSON.stringify(tasksIn(storage, ASSIGNMENTS)[B]);
  void custody.retry(A);
  await settleMicrotasks();
  await server.calls[2]?.answer(refused('SCOPE_NOT_GRANTED'));
  custody.letGo(A, server.ids()[1]!);
  expect(custody.snapshot().holds.get(A)?.pending?.operationId).toBe(heldId);
  custody.letGo(A, heldId);
  custody.letGo(A, heldId);
  expect(custody.snapshot().holds.get(A)).toMatchObject({ pending: null, abandoned: false });
  expect(JSON.stringify(tasksIn(storage, ASSIGNMENTS)[B])).toBe(sibling);
  expect(storage.getItem(ASSIGNMENTS)).not.toContain(heldId);
  void custody.choose(A, 4, { assignee: PERSON });
  await settleMicrotasks();
  expect(server.ids()[3]).not.toBe(heldId);
});

it('Stop waiting on a comment is a no-op mid-retry, announces the let-go once, and keeps the other task', async () => {
  const server = held();
  const storage = store();
  const custody = new CommentCustody(server.client, OWNER, storage);
  void custody.post(A, words(server.client.newOperationId()));
  void custody.post(B, words(server.client.newOperationId()));
  await settleMicrotasks();
  await server.calls[0]?.answer(lost());
  await server.calls[1]?.answer(lost());
  const heldId = server.ids()[0]!;
  const sibling = JSON.stringify(tasksIn(storage, COMMENTS)[B]);
  void custody.post(A, words('unused'));
  await settleMicrotasks();
  expect(server.ids()[2]).toBe(heldId);
  custody.letGo(A, heldId);
  expect(custody.snapshot(A).pending?.operationId).toBe(heldId);
  await server.calls[2]?.answer(refused('SCOPE_NOT_GRANTED'));
  const before = custody.snapshot(A).settlement;
  custody.letGo(A, heldId);
  custody.letGo(A, heldId);
  expect(custody.snapshot(A)).toMatchObject({ pending: null, answered: 'abandoned' });
  expect(custody.snapshot(A).settlement).toBe(before + 1);
  expect(custody.snapshot(A).settled?.operationId).toBe(heldId);
  expect(JSON.stringify(tasksIn(storage, COMMENTS)[B])).toBe(sibling);
  expect(storage.getItem(COMMENTS)).not.toContain(heldId);
});
