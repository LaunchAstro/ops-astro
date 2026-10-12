// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// With site data blocked the App's assignment provider keeps recovery in
// memory. That changes where a held attempt lives, not what is checked: an
// assignment chosen without the revision it was read at is not sent.
import { act } from 'react';
import { expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import {
  AssignmentProvider,
  useAssignments,
} from '../../apps/web/src/screens/task/assignment-context.tsx';
import type { AssignmentCustody } from '../../apps/web/src/screens/task/assignment-custody.ts';
import { mount } from '../surfaces/mount.tsx';

const TASK = '11111111-1111-4111-8111-11111111111a';
const PERSON = '22222222-2222-4222-8222-222222222222';

it('the App assignment provider with no tab storage sends no assignment without a revision', async () => {
  const sent: unknown[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return Promise.resolve(new Response(JSON.stringify({ recordId: TASK, revision: 5 })));
  };
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  const seen: { custody: AssignmentCustody | null } = { custody: null };
  function Probe() {
    seen.custody = useAssignments(client, 'alpha:ada').custody;
    return null;
  }
  const view = await mount(
    <AssignmentProvider client={client} grantKey="alpha:ada" storage={null}>
      <Probe />
    </AssignmentProvider>,
  );
  await act(async () => {
    await seen.custody?.choose(TASK, undefined, { assignee: PERSON });
  });
  expect(sent).toEqual([]);
  await act(async () => {
    await seen.custody?.choose(TASK, 4, { assignee: PERSON });
  });
  expect(sent).toEqual([expect.objectContaining({ expectedRevision: 4 })]);
  await view.unmount();
});
