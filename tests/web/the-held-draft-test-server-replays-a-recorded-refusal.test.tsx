// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// The held-draft suites' server keeps a refusal by its operation id, as the
// register does, so a retry under that id is answered with the same refusal.

import { expect, it } from 'vitest';
import { FIRST_ID, server } from './draft-removal-refused-support.tsx';

it('a retry under a refused operation id is answered with the recorded refusal', async () => {
  const api = server();
  const body = { fields: { title: 'Renew the domain' } };
  api.next.refuse = true;
  const first = await api.client.mutate('task.create', body, { operationId: FIRST_ID });
  expect(first).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
  // registerAttempt records refused results too; lookupAttempt returns that
  // result on the same identity. A later retry cannot invent an applied task.
  const replay = await api.client.mutate('task.create', body, { operationId: FIRST_ID });
  expect(replay, 'the register replays a refusal instead of applying the same identity').toEqual(
    first,
  );
  expect(api.tasks).toEqual([]);
});
