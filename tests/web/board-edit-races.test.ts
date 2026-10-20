// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's custodian, with tab storage and without it (site data blocked),
// under two presses at once, lost answers and late answers. Answers are held
// back and released by hand, so the order of each race is the test's choice.
// Discard of an unreadable recovery copy acts once, for the owner that read it,
// on the exact bytes it read.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { BoardEditCustody } from '../../apps/web/src/screens/projects/board-edit-custody.ts';
import { SessionStore } from '../../apps/web/src/session/token.ts';
import { store } from './draft-support.tsx';

const OWNER = 'alpha:ada@example.test:0';
const TASK = '11111111-1111-4111-8111-11111111111a';
const SLOT = 'ops-astro.board-edit-attempts';

interface Call {
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
function heldServer() {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) =>
    new Promise((resolve, reject) => {
      calls.push({
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        answer: async (reply) => {
          if (reply instanceof Error) reject(reply);
          else resolve(reply);
          await settleMicrotasks();
        },
      });
    });
  const client = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const ids = (): string[] => calls.map((call) => String(call.body['operationId']));
  return { calls, client, ids };
}

const lost = (): Error => new TypeError('Failed to fetch');
const receipt = (): Response =>
  new Response(JSON.stringify({ recordId: TASK, revision: 5, detail: {} }));
const refused = (code: string): Response =>
  new Response(JSON.stringify({ refused: true, code, names: [], fixes: [] }), { status: 409 });
const rename = (title: string) =>
  ({ command: 'task.update', body: { recordId: TASK, fields: { title } } }) as const;

for (const storage of ['tab storage', 'no tab storage'] as const) {
  const tab = (): Storage | null => (storage === 'tab storage' ? store() : null);

  it(`with ${storage}, two edits of one task at once send one request, and a retry in flight is not sent twice`, async () => {
    const server = heldServer();
    const custody = new BoardEditCustody(server.client(), OWNER, tab());
    expect(custody.choose(rename('First'), 4)).toBe(true);
    expect(custody.choose(rename('Second'), 4)).toBe(false);
    await settleMicrotasks();
    expect(server.calls).toHaveLength(1);
    await server.calls[0]?.answer(lost());
    void custody.retry(TASK);
    void custody.retry(TASK);
    await settleMicrotasks();
    expect(server.ids()).toEqual([server.ids()[0], server.ids()[0]]);
    await server.calls[1]?.answer(receipt());
    expect(custody.snapshot().holds.has(TASK)).toBe(false);
    await custody.retry(TASK);
    expect(server.calls).toHaveLength(2);
  });

  it(`with ${storage}, a lost edit retried and answered VERSION_STALE settles, and the next edit is new`, async () => {
    const server = heldServer();
    const custody = new BoardEditCustody(server.client(), OWNER, tab());
    custody.choose(rename('First'), 4);
    await settleMicrotasks();
    await server.calls[0]?.answer(lost());
    void custody.retry(TASK);
    await settleMicrotasks();
    expect(server.calls[1]?.body).toStrictEqual(server.calls[0]?.body);
    expect(server.calls[1]?.body['expectedRevision']).toBe(4);
    await server.calls[1]?.answer(refused('VERSION_STALE'));
    expect(custody.snapshot().holds.has(TASK)).toBe(false);
    await custody.retry(TASK);
    expect(server.calls).toHaveLength(2);
    expect(custody.choose(rename('Second'), 5)).toBe(true);
    await settleMicrotasks();
    expect(server.ids()[2]).not.toBe(server.ids()[0]);
  });

  it(`with ${storage}, a lost edit refused on retry stays held under its id`, async () => {
    const server = heldServer();
    const custody = new BoardEditCustody(server.client(), OWNER, tab());
    custody.choose(rename('First'), 4);
    await settleMicrotasks();
    await server.calls[0]?.answer(lost());
    void custody.retry(TASK);
    await settleMicrotasks();
    await server.calls[1]?.answer(refused('SCOPE_NOT_GRANTED'));
    expect(custody.snapshot().holds.get(TASK)?.entry.attempt.operationId).toBe(server.ids()[0]);
    void custody.retry(TASK);
    await settleMicrotasks();
    expect(server.ids()[2]).toBe(server.ids()[0]);
  });

  it(`with ${storage}, a new sign-in while an edit is in flight drops the old answer and the retry keeps the id`, async () => {
    const server = heldServer();
    const custody = new BoardEditCustody(server.client(), OWNER, tab());
    custody.choose(rename('First'), 4);
    await settleMicrotasks();
    custody.rebind(server.client());
    // The old bearer's answer arrives after the rebind, in both orders with the retry.
    await server.calls[0]?.answer(receipt());
    expect(custody.snapshot().holds.get(TASK)?.busy).toBe(false);
    void custody.retry(TASK);
    await settleMicrotasks();
    expect(server.ids()[1]).toBe(server.ids()[0]);
    await server.calls[1]?.answer(receipt());
    expect(custody.snapshot().holds.has(TASK)).toBe(false);
  });
}

it('Discard of an unreadable copy acts once: a second press, or a copy replaced in between, removes nothing more', () => {
  const tab = store();
  tab.setItem(SLOT, '{"bogus":1}');
  const custody = new BoardEditCustody(heldServer().client(), OWNER, tab);
  custody.activate();
  expect(custody.snapshot().problem).not.toBeNull();
  custody.discard();
  expect(tab.getItem(SLOT)).toBeNull();
  expect(custody.snapshot().problem).toBeNull();
  // Another tab keeps a new copy after the discard; a second press must not touch it.
  tab.setItem(SLOT, '{"bogus":1}');
  custody.discard();
  expect(tab.getItem(SLOT)).toBe('{"bogus":1}');
});

it('Discard by a custodian whose owner changed leaves the new owner’s identical copy alone', () => {
  const tab = store();
  tab.setItem(SLOT, '{"bogus":1}');
  const departed = new BoardEditCustody(heldServer().client(), OWNER, tab);
  departed.activate();
  new SessionStore(tab).clear();
  const current = new BoardEditCustody(heldServer().client(), 'alpha:ada@example.test:1', tab);
  current.activate();
  departed.discard();
  expect(tab.getItem(SLOT)).toBe('{"bogus":1}');
  expect(current.snapshot().problem).not.toBeNull();
  current.discard();
  expect(tab.getItem(SLOT)).toBeNull();
  expect(current.snapshot().problem).toBeNull();
});
