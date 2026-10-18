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
