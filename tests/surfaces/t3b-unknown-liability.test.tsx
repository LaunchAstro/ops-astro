// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T3b on the task page: an unknown liability is visible, raised as something
// a person has to answer, and drawn apart from settled money. Its full hold is
// named as unknown, never as spent, and it is not in the settled list beside
// a settled attempt's spend and release.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '55555555-5555-4555-8555-555555555555';

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

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const reservation = (id: string, attemptState: string, extra: Record<string, unknown>) => ({
  id,
  state: 'held',
  heldMinor: 2_500,
  actualMinor: null,
  classifiedCause: null,
  leaseId: null,
  lease: { state: 'expired', fence: 1, expiresAt: '2026-09-29T05:00:00.000Z' },
  attempt: { id: `a-${id}`, state: attemptState, dispatchMarker: true, observed: null },
  ...extra,
});

function client(): OperationsClient {
  const task = {
    id: TASK_ID,
    key: 'TSK-51',
    title: 'A task whose step was never confirmed',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: null,
    due: null,
    priority: null,
    completedAt: null,
    revision: 4,
    history: [],
    comments: [],
    proposals: [
      {
        lineageId: 'l-5555',
        state: 'live',
        versions: [],
        decisions: [],
        reservations: [
          reservation('r-unknown', 'liability_unknown', {}),
          reservation('r-settled', 'settled', {
            state: 'actual',
            actualMinor: 1_800,
            releasedMinor: 700,
          }),
        ],
      },
    ],
  };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    return json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
}

describe('the unknown liability on the task page', () => {
  it('is raised for a person, apart from settled money, at its full hold', async () => {
    const page = await mount(
      <TaskDetailScreen client={client()} grantKey="alpha:ada" taskKey="TSK-51" />,
    );
    await tick();

    const unknown = page.find('[data-unknown-liability="r-unknown"]');
    expect(unknown).not.toBeNull();
    expect(unknown?.textContent).toContain('25.00');
    expect(unknown?.textContent).toMatch(/needs a person/iu);
    expect(unknown?.textContent).not.toMatch(/spent/iu);

    const settled = page.all('[data-reservations="list"] [data-reservation-id]');
    expect(settled.map((node) => node.getAttribute('data-reservation-id'))).toStrictEqual([
      'r-settled',
    ]);
    expect(page.find('[data-reservations="list"]')?.textContent).not.toMatch(/unknown/iu);
  });
});
