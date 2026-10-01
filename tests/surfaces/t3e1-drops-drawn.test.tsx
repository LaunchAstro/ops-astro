// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// T3e1 on the task page: each drop is drawn in its own words, naming what
// failed under the work, and never as a person's cancellation; a cancelled
// attempt carries no drop words at all.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from './mount.tsx';

const TASK_ID = '66666666-6666-4666-8666-666666666666';

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
  lease: null,
  attempt: { id: `a-${id}`, state: attemptState, dispatchMarker: false, observed: null, ...extra },
});

function client(): OperationsClient {
  const task = {
    id: TASK_ID,
    key: 'TSK-61',
    title: 'A task whose work dropped three ways',
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
        lineageId: 'l-6666',
        state: 'live',
        versions: [],
        decisions: [],
        reservations: [
          reservation('r-provider', 'dropped', { dropCause: 'provider_unavailable' }),
          reservation('r-connection', 'dropped', { dropCause: 'connection_lost' }),
          reservation('r-worker', 'dropped', { dropCause: 'worker_lost' }),
          reservation('r-cancelled', 'abandoned', { dropCause: null }),
        ],
      },
    ],
  };
  const answer = (url: string | URL): Response => {
    const at = String(url);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    if (at.endsWith('/task/read')) return json({ ok: true, task });
    return json({ ok: true });
  };
  const fetch = ((url: string | URL) =>
    Promise.resolve(answer(url))) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
}

describe('drops on the task page', () => {
  it('draws each cause in its own words, and a cancellation with none', async () => {
    const page = await mount(
      <TaskDetailScreen client={client()} grantKey="alpha:ada" taskKey="TSK-61" />,
    );
    await tick();

    const row = (id: string): string =>
      page.find(`[data-reservation-id="${id}"] [data-attempt-state]`)?.textContent ?? '';
    expect(row('r-provider')).toContain('Dropped — the provider did not answer');
    expect(row('r-connection')).toContain('Dropped — the connection was lost');
    expect(row('r-worker')).toContain('Dropped — our worker was lost');
    expect(row('r-cancelled')).toBe('attempt abandoned');
    for (const id of ['r-provider', 'r-connection', 'r-worker']) {
      expect(row(id)).not.toMatch(/cancel/iu);
    }
  });
});
