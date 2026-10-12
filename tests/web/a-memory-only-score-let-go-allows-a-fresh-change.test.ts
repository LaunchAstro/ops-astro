// SPDX-License-Identifier: AGPL-3.0-only
//
// A score change sent without reload recovery is kept in this tab's memory
// only. Letting it go leaves no stored copy to clear, so the next score change
// is a new request at once and no cleanup control is left behind.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { ScoresCustody } from '../../apps/web/src/screens/task/scores-custody.ts';

const OWNER = 'alpha:ada@example.test:0';
const TASK = '11111111-1111-4111-8111-11111111111a';

const pause = (): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, 0);
  });

function server(answers: (() => Response | Error)[]) {
  const ids: string[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    ids.push(String((JSON.parse(String(init?.body)) as { operationId: unknown }).operationId));
    const answer = answers.shift()?.() ?? new TypeError('Failed to fetch');
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return {
    ids,
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
  };
}

const refused = (): Response =>
  new Response(JSON.stringify({ refused: true, code: 'SCOPE_NOT_GRANTED', names: [], fixes: [] }), {
    status: 403,
  });

it('letting go of a memory-only score change permits a fresh score change', async () => {
  const api = server([() => new TypeError('Failed to fetch'), refused]);
  const custody = new ScoresCustody(api.client, OWNER, null);
  custody.choose(TASK, 4, 'impact', 10);
  expect(custody.snapshot(TASK).kept).toBe(false);
  custody.sendEphemeral(TASK);
  await pause();
  custody.retry(TASK);
  await pause();
  const held = custody.snapshot(TASK);
  expect(held.uncertain).toBe(true);
  custody.letGo(TASK, held.pending?.operationId ?? '');
  expect(custody.snapshot(TASK).pending).toBeNull();
  expect(custody.snapshot(TASK).abandoned).toBe(false);
  custody.choose(TASK, 4, 'impact', 9);
  expect(custody.snapshot(TASK).pending?.value).toBe(9);
  expect(custody.snapshot(TASK).pending?.operationId).not.toBe(held.pending?.operationId);
  expect(custody.snapshot(TASK).ephemeral).toBe(false);
});

/** A memory-only change lost, then its retry refused: held, with Stop waiting offered. */
async function heldMemoryOnly() {
  const api = server([() => new TypeError('Failed to fetch'), refused]);
  const custody = new ScoresCustody(api.client, OWNER, null);
  custody.choose(TASK, 4, 'impact', 10);
  custody.sendEphemeral(TASK);
  await pause();
  custody.retry(TASK);
  await pause();
  return { custody, id: custody.snapshot(TASK).pending?.operationId ?? '' };
}

/** A client whose sends wait for `land`; the change was stored. */
function lateClient() {
  let land: (() => void) | null = null;
  const late = new Promise<Response>((done) => {
    land = () => done(new Response(JSON.stringify({ recordId: TASK, revision: 5, detail: {} })));
  });
  const fetch: typeof globalThis.fetch = () => late;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    land: () => land?.(),
  };
}

/** The retry goes out on `late`, then the client changes, so the hold is no longer busy. */
async function letGoWhileOut() {
  const held = await heldMemoryOnly();
  const late = lateClient();
  held.custody.rebind(late.client);
  held.custody.retry(TASK);
  held.custody.rebind(server([]).client);
  held.custody.letGo(TASK, held.id);
  expect(held.custody.snapshot(TASK).pending).toBeNull();
  return { ...held, late, before: held.custody.snapshot(TASK).changed };
}

it('a memory-only score change cannot be let go while its retry is out, and the answer settles it', async () => {
  const held = await heldMemoryOnly();
  const late = lateClient();
  held.custody.rebind(late.client);
  held.custody.retry(TASK);
  held.custody.letGo(TASK, held.id);
  expect(held.custody.snapshot(TASK).pending?.operationId, 'busy: Stop waiting waits').toBe(
    held.id,
  );
  const before = held.custody.snapshot(TASK).changed;
  late.land();
  await pause();
  expect(held.custody.snapshot(TASK).pending).toBeNull();
  expect(held.custody.snapshot(TASK).changed).toBe(before + 1);
});

it('a late answer for a let-go memory-only change does not bring it back', async () => {
  const held = await letGoWhileOut();
  held.late.land();
  await pause();
  expect(held.custody.snapshot(TASK).pending).toBeNull();
  expect(held.custody.snapshot(TASK).abandoned).toBe(false);
  held.custody.choose(TASK, 5, 'impact', 9);
  expect(held.custody.snapshot(TASK).pending?.value).toBe(9);
  expect(held.custody.snapshot(TASK).pending?.operationId).not.toBe(held.id);
});

it('a late stored answer for a let-go memory-only change still counts the change', async () => {
  const held = await letGoWhileOut();
  held.late.land();
  await pause();
  expect(held.custody.snapshot(TASK).changed, 'the page reads the stored change').toBe(
    held.before + 1,
  );
});
