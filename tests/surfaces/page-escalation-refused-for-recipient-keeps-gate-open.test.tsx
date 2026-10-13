// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// An escalation the server refuses for its recipient, `SCOPE_NOT_GRANTED`
// naming `recipientPersonId`, is about the person chosen, not about the one
// deciding. On the task page it closes nothing: the refusal is shown, and the
// decider may choose again or approve, as the dock panel's Agent side allows.
// A refusal for the decider's own grant still closes the controls.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const tick = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const GATE = {
  id: 'g-3',
  state: 'pending',
  round: 3,
  expiresAt: '2099-01-01T00:00:00.000Z',
  expired: false,
  payloadDigest: 'digest-v-3',
};

const TASK = {
  id: '44444444-4444-4444-8444-444444444444',
  key: 'TSK-44',
  title: 'A proposal at its bound',
  description: null,
  state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 7,
  history: [],
  comments: [],
  proposals: [
    {
      lineageId: 'l-1',
      state: 'live',
      decisions: [],
      reservations: [],
      versions: [
        {
          versionId: 'v-3',
          version: 3,
          purpose: 'synthetic_comment',
          maximumMinor: 2_000,
          currency: 'AUD',
          payloadDigest: 'digest-v-3',
          payload: { change: 'a team-only comment' },
          supersededAt: null,
          runId: null,
          evidence: null,
          gate: GATE,
          checks: [],
        },
      ],
    },
  ],
};

/** One task at its revision bound; `task.decide` refused naming `names`. */
function server(names: readonly string[]) {
  const decided: Record<string, unknown>[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) {
      return Promise.resolve(
        json({
          ok: true,
          persons: [
            { personId: 'p-ada', name: 'Ada' },
            { personId: 'p-xavier', name: 'Xavier' },
          ],
        }),
      );
    }
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: TASK }));
    if (at.endsWith('/task/decide')) {
      decided.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      return Promise.resolve(
        json({ refused: true, code: 'SCOPE_NOT_GRANTED', names, fixes: [] }, 403),
      );
    }
    return Promise.resolve(json({ refused: true, code: 'NOT_FOUND', names: [], fixes: [] }, 404));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
  return { client, decided };
}

async function escalateTo(names: readonly string[]) {
  const { client, decided } = server(names);
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-44" />,
  );
  await tick();
  await page.choose('[data-escalate="recipient"]', 'p-xavier');
  await page.click('[data-decide="escalate"]');
  await tick();
  return { page, decided };
}

describe('an escalation refused on the task page', () => {
  it('for its recipient keeps the gate controls open', async () => {
    const { page, decided } = await escalateTo(['recipientPersonId']);
    expect(decided).toHaveLength(1);
    const approve = page.find('[data-decide="approve"]') as HTMLButtonElement | null;
    expect(approve).not.toBeNull();
    expect(approve?.disabled).toBe(false);
    expect((page.find('[data-escalate="recipient"]') as HTMLSelectElement | null)?.value).toBe(
      'p-xavier',
    );
    await page.unmount();
  });

  it("for the decider's own grant closes them", async () => {
    const { page } = await escalateTo([]);
    expect(page.find('[data-decide="approve"]')).toBeNull();
    await page.unmount();
  });
});
