// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// A decision held for a step-up code is not sent once the task's decide
// controls have closed (catalogue #584).
//
// Approve on one gate in the Agent pane asks for a code, and the page is held
// open under the prompt. Meanwhile a decision on another gate in the proposals
// is refused for want of the grant, which closes every decide control on the
// task rather than asking again on the reader's behalf. The code entered after
// that must not send the held decision.

import { useState } from 'react';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount } from './mount.tsx';
import { json, refused, taskWith, tick } from './task-page-fixture.tsx';

/** The fixture's task with a second proposal, on its own gate. */
function twoGateTask() {
  const task = taskWith({ state: 'pending', expired: false });
  const [first] = task.proposals;
  if (first === undefined) throw new Error('the fixture task has no proposal');
  const [version] = first.versions;
  if (version === undefined) throw new Error('the fixture proposal has no version');
  const later = {
    ...first,
    lineageId: 'l-2',
    versions: [{ ...version, versionId: 'v-2', gate: { ...version.gate, id: 'g-2' } }],
  };
  return { ...task, proposals: [first, later] };
}

/** The first decision asks for a code, the second is refused the grant; each gate decided is kept. */
function server() {
  const decided: string[] = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: twoGateTask() });
    if (at.endsWith('/task/decide')) {
      const body = JSON.parse(String(init?.body)) as { readonly gateId?: string };
      decided.push(body.gateId ?? 'no gate');
      if (decided.length === 1) return refused('STEP_UP_REQUIRED', 403);
      if (decided.length === 2) return refused('SCOPE_NOT_GRANTED', 403);
      return json({ recordId: null, revision: null, detail: {} });
    }
    return refused('NOT_FOUND', 404);
  }) as unknown as typeof globalThis.fetch;
  const signIn = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { decided, first: signIn(), steppedUp: signIn() };
}

it('a code entered after the decide controls closed does not send the held decision', async () => {
  const api = server();
  function Screen() {
    const [client, setClient] = useState(api.first);
    return (
      <StepUpContext.Provider
        value={async () => {
          await Promise.resolve();
          setClient(api.steppedUp);
          return { ok: true, sessionId: 'stepped-up' };
        }}
      >
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />
      </StepUpContext.Provider>
    );
  }
  const page = await mount(<Screen />);
  try {
    await tick();
    await page.click('#perspective-tab-agent');
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();

    // The Agent pane draws the first proposal's gate; the proposals decide on the other.
    expect(api.decided).toEqual(['g-1']);
    await page.click('[data-proposals="list"] > :last-child [data-decide="approve"]');
    await tick();
    expect(api.decided).toEqual(['g-1', 'g-2']);
    expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();

    if (page.find('[data-step-up="code"]') !== null) {
      await page.type('[data-step-up="code"]', '123456');
      await page.click('[data-step-up="confirm"]');
    }
    await tick();
    await tick();
    expect(api.decided, 'the held decision on g-1 must not go out once decide is closed').toEqual([
      'g-1',
      'g-2',
    ]);
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
  } finally {
    await page.unmount();
  }
});
