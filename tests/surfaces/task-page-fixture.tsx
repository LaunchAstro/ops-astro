// SPDX-License-Identifier: AGPL-3.0-only
//
// One task page on a stubbed server: a task with one proposal and its gate in
// the state given, every read answered and each write refused as the case
// says. The render pins and the decision-refusal proofs mount it.

import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const refused = (code: string, status: number): Response =>
  json({ refused: true, code, names: ['task'], fixes: ['Read the task again.'] }, status);

export const TASK_ID = '44444444-4444-4444-8444-444444444444';

export function taskWith(gate: { readonly state: string; readonly expired: boolean }) {
  return {
    id: TASK_ID,
    key: 'TSK-41',
    title: 'A task with one proposal',
    description: null,
    state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
    assignee: { personId: 'p-1', name: 'Ada' },
    due: '2026-10-01T00:00:00.000Z',
    priority: null,
    completedAt: null,
    revision: 3,
    history: [
      {
        at: '2026-09-22T01:00:00.000Z',
        actorId: 'p-1',
        personId: 'p-1',
        actorKind: 'person',
        actorName: 'Ada',
        operation: 'task.create',
      },
    ],
    board: null,
    rank: { number: null, score: null, calc: '' },
    adHoc: false,
    clientAccess: false,
    stage: null,
    clientSet: false,
    steps: [],
    time: null,
    comments: [
      {
        id: 'c-1',
        body: 'First note',
        audience: 'internal',
        comment_type: 'note',
        author: 'p-1',
        posted_at: '2026-09-22T02:00:00.000Z',
      },
    ],
    // The task cap's currency, which the propose form offers (CQ-7).
    capCurrency: 'AUD',
    proposals: [
      {
        lineageId: 'l-1',
        state: 'live',
        versions: [
          {
            versionId: 'v-1',
            version: 1,
            purpose: 'client_renewal_quote',
            maximumMinor: 250_000,
            currency: 'AUD',
            payloadDigest: 'digest-1',
            payload: { step: 'draft the quote' },
            supersededAt: null,
            runId: null,
            checks: [],
            evidence: null,
            gate: {
              id: 'g-1',
              state: gate.state,
              round: 1,
              expiresAt: '2026-09-23T05:00:00.000Z',
              expired: gate.expired,
              payloadDigest: 'digest-1',
            },
          },
        ],
        decisions: [],
        reservations: [],
      },
    ],
  };
}

/** Every write refused with the code given for it; every read answered. */
export function taskServer(
  gate: { readonly state: string; readonly expired: boolean },
  writes: Readonly<Record<string, Response>> = {},
) {
  const fetch = ((url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) {
      return Promise.resolve(json({ ok: true, persons: [{ personId: 'p-1', name: 'Ada' }] }));
    }
    if (at.endsWith('/task/read')) return Promise.resolve(json({ ok: true, task: taskWith(gate) }));
    for (const [suffix, response] of Object.entries(writes)) {
      if (at.endsWith(suffix)) return Promise.resolve(response.clone());
    }
    return Promise.resolve(refused('NOT_FOUND', 404));
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch,
    newOperationId: () => 'operation-1',
  });
}

export const taskPage = async (client: OperationsClient): Promise<Mounted> => {
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />,
  );
  await tick();
  return page;
};
