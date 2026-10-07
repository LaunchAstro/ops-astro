// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: ending access answers 403 `AUTH_ACCESS_ENDED`, its own code, so no
// earlier answer is needed to tell it from a login never a member here: the
// session ends on it whatever the call before it was answered.

import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';

const refused = (code: string) => ({ refused: true, code, names: [], fixes: [] });

/** What `onSessionEnded` heard over two calls: `first` answered, then access ended. */
async function endedAfter(first: string, status: number): Promise<readonly string[]> {
  const answers = [
    Response.json(refused(first), { status }),
    Response.json(refused('AUTH_ACCESS_ENDED'), { status: 403 }),
  ];
  const ended: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: (() => Promise.resolve(answers.shift())) as unknown as typeof globalThis.fetch,
    onSessionEnded: (refusal) => ended.push(refusal.code),
  });
  await client.read('task.board', { board: null });
  await client.read('task.board', { board: null });
  return ended;
}

it('ends the session on the access-ended code whatever the call before it was answered', async () => {
  const before = [
    ['SCOPE_NOT_GRANTED', 403],
    ['AUTH_NO_MEMBERSHIP', 403],
    ['ACTOR_INACTIVE', 403],
    ['AUTH_SESSION_MISMATCH', 403],
    ['AUTH_CROSS_SITE', 403],
    ['COMMAND_BODY_INVALID', 400],
    ['AUTH_SECOND_FACTOR_REQUIRED', 401],
  ] as const;
  const heard = await Promise.all(
    before.map(async ([code, status]) => await endedAfter(code, status)),
  );
  expect(heard).toEqual(before.map(() => ['AUTH_ACCESS_ENDED']));
});
