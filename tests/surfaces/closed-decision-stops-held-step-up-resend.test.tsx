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
// that must not send the held decision, nor may a code that passed before
// then once the new sign-in lands. A prompt held for another command,
// a top-up at a budget stop, is not a decision and stays open.

import { useState } from 'react';
import { expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { StepUpContext } from '../../apps/web/src/records/use-money-command.ts';
import { mount, type Mounted } from './mount.tsx';
import { json, refused, taskWith, tick } from './task-page-fixture.tsx';

/** A run stopped at its ceiling, answered from the Agent pane with a top-up. */
const stop = {
  askId: 'ask-1',
  runId: 'run-1',
  number: 1,
  kind: 'stop',
  ceilingMinor: 400,
  spentMinor: 390,
  currency: 'AUD',
  raisedAt: '2026-10-01T00:00:00Z',
  answer: null,
  awaitingSecond: null,
};

/** The fixture's task with a second proposal, on its own gate, and a budget stop. */
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
  return { ...task, proposals: [first, later], ledger: { envelopes: [], stops: [stop] } };
}

const STEP_UP = (): Response => refused('STEP_UP_REQUIRED', 403);
const NOT_GRANTED = (): Response => refused('SCOPE_NOT_GRANTED', 403);
const done = (): Response => json({ recordId: null, revision: null, detail: {} });

/** Each decide and top-up answered in turn, then accepted; every gate decided and top-up sent is kept. */
function server(decides: readonly (() => Response)[], topUps: readonly (() => Response)[] = []) {
  const decided: string[] = [];
  let toppedUp = 0;
  const answer = (url: string | URL, init?: RequestInit): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task: twoGateTask() });
    if (at.endsWith('/task/decide')) {
      const body = JSON.parse(String(init?.body)) as { readonly gateId?: string };
      decided.push(body.gateId ?? 'no gate');
      return (decides[decided.length - 1] ?? done)();
    }
    if (at.endsWith('/run/top_up')) {
      toppedUp += 1;
      return (topUps[toppedUp - 1] ?? done)();
    }
    return refused('NOT_FOUND', 404);
  };
  const fetch = ((url: string | URL, init?: RequestInit) =>
    Promise.resolve(answer(url, init))) as unknown as typeof globalThis.fetch;
  const signIn = (): OperationsClient =>
    new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch });
  return { decided, toppedUp: () => toppedUp, first: signIn(), steppedUp: signIn() };
}

/** The task page under a sign-in a good code steps up, on to the stepped-up client once `landing` settles. */
async function stepUpPage(
  api: ReturnType<typeof server>,
  landing?: Promise<void>,
): Promise<Mounted> {
  function Screen() {
    const [client, setClient] = useState(api.first);
    return (
      <StepUpContext.Provider
        value={async () => {
          await Promise.resolve();
          if (landing === undefined) setClient(api.steppedUp);
          else void landing.then(() => setClient(api.steppedUp));
          return { ok: true, sessionId: 'stepped-up' };
        }}
      >
        <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />
      </StepUpContext.Provider>
    );
  }
  const page = await mount(<Screen />);
  await tick();
  await page.click('#perspective-tab-agent');
  return page;
}

/** A decision on the gate the Agent pane does not draw, from the proposals, refused the grant. */
async function refuseOtherGate(page: Mounted): Promise<void> {
  await page.click('[data-proposals="list"] > :last-child [data-decide="approve"]');
  await tick();
  expect(page.find('[data-agent="gate-actions"] [data-gate="closed"]')).not.toBeNull();
}

it('a code entered after the decide controls closed does not send the held decision', async () => {
  const api = server([STEP_UP, NOT_GRANTED]);
  const page = await stepUpPage(api);
  try {
    await page.click('[data-gate-action="approve"]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();

    // The Agent pane draws the first proposal's gate; the proposals decide on the other.
    expect(api.decided).toEqual(['g-1']);
    await refuseOtherGate(page);
    expect(api.decided).toEqual(['g-1', 'g-2']);

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

it('a code passed before the decide controls closed sends nothing once the new sign-in lands', async () => {
  const api = server([STEP_UP, NOT_GRANTED]);
  let land: (() => void) | undefined;
  const page = await stepUpPage(
    api,
    new Promise((resolve) => {
      land = resolve;
    }),
  );
  try {
    await page.click('[data-gate-action="approve"]');
    await tick();
    await page.type('[data-step-up="code"]', '123456');
    await page.click('[data-step-up="confirm"]');
    await tick();
    expect(page.find('[data-step-up="prompt"]')).toBeNull();
    expect(api.decided).toEqual(['g-1']);

    await refuseOtherGate(page);
    land?.();
    await tick();
    await tick();
    expect(api.decided, 'the held decision on g-1 must not go out once decide is closed').toEqual([
      'g-1',
      'g-2',
    ]);
  } finally {
    await page.unmount();
  }
});

it('a top-up held for a code keeps its prompt when the decide controls close', async () => {
  const api = server([NOT_GRANTED], [STEP_UP]);
  const page = await stepUpPage(api);
  try {
    await page.type('[data-section="agent"] [data-stop="amount"]', '2.50');
    await page.click('[data-section="agent"] [data-stop="top-up"]');
    await tick();
    expect(api.toppedUp()).toBe(1);
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();

    await refuseOtherGate(page);
    expect(page.find('[data-step-up="prompt"]')).not.toBeNull();

    await page.type('[data-step-up="code"]', '123456');
    await page.click('[data-step-up="confirm"]');
    await tick();
    await tick();
    expect(api.toppedUp(), 'the held top-up goes once more on the stepped-up sign-in').toBe(2);
  } finally {
    await page.unmount();
  }
});
