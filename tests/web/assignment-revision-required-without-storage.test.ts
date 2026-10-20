// SPDX-License-Identifier: AGPL-3.0-only
//
// With no tab storage the App keeps assignment recovery in memory only. That
// changes where a held attempt lives, not what is sent: an assignment still
// needs the revision it was chosen at. Only the isolated board row sender may
// send without one.
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';

const TASK = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';

function counted() {
  const sent: unknown[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ recordId: TASK, revision: 5 })));
  };
  return {
    sent,
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
  };
}

it('An assignment kept in memory without tab storage still needs its revision', async () => {
  const { sent, client } = counted();
  // As the App provider builds it when tab storage is blocked.
  const custody = new AssignmentCustody(client, 'alpha:ada', null, true, false);
  expect(await custody.choose(TASK, undefined, { assignee: PERSON })).toBeUndefined();
  expect(sent).toEqual([]);
  await custody.choose(TASK, 4, { assignee: PERSON });
  expect(sent).toEqual([expect.objectContaining({ expectedRevision: 4 })]);
});

it('The isolated board row sender may still assign without a revision', async () => {
  const { sent, client } = counted();
  const custody = new AssignmentCustody(client, 'alpha', null, true, true);
  await custody.choose(TASK, undefined, { assignee: PERSON });
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toHaveProperty('expectedRevision');
});
