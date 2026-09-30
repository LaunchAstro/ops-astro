// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for the task page's server in the MP-4-1 cases: `task.read`
// answers whatever is queued for the key it is asked about, in the shape the
// API sends it (`packages/core-wire/src/views.ts`).

import { act } from 'react';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

export const TASK_ID = '33333333-3333-4333-8333-333333333333';

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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const NOT_FOUND = {
  refused: true,
  code: 'NOT_FOUND',
  names: ['task'],
  fixes: ['check the address'],
};

const attempt = (state: string, index: number) => ({
  id: `r-${state}-${index}`,
  state: 'held',
  heldMinor: 100,
  actualMinor: null,
  classifiedCause: null,
  leaseId: null,
  lease: null,
  attempt: { id: `a-${state}-${index}`, state, dispatchMarker: false, observed: false },
});

/** One approved proposal whose reservations carry attempts in these states. */
export const proposalWith = (...states: readonly string[]) => ({
  lineageId: `l-${states.join('-')}`,
  state: 'approved',
  versions: [],
  decisions: [],
  reservations: states.map((state, index) => attempt(state, index)),
});

export const task = (over: Readonly<Record<string, unknown>> = {}) => ({
  id: TASK_ID,
  key: 'Proj-Verity-Pacing',
  title: 'Budget pacing fix',
  description: null,
  agentBrief: null,
  state: { id: 's1', key: 'awaiting', label: 'Awaiting approval', machineCategory: 'started' },
  assignee: null,
  due: null,
  priority: null,
  completedAt: null,
  revision: 4,
  history: [],
  comments: [],
  proposals: [],
  capCurrency: null,
  rank: { number: 4, score: 504, calc: 'impact 7 × confidence 9 × ease 8 = 504 · derived' },
  adHoc: false,
  clientAccess: false,
  board: { readable: true, id: '44444444-4444-4444-8444-444444444444', title: 'Website Projects' },
  stage: null,
  clientSet: false,
  steps: [],
  time: null,
  ...over,
});

export type Answers = Readonly<Record<string, { body: unknown; status?: number }>>;

export function server(answers: Answers): OperationsClient {
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    if (at.endsWith('/person/list')) return Promise.resolve(json({ ok: true, persons: [] }));
    if (!at.endsWith('/task/read')) throw new Error(`unrouted ${at}`);
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
      recordId?: unknown;
    };
    const answer = answers[String(body.recordId)];
    if (answer === undefined) throw new Error(`no answer queued for ${String(body.recordId)}`);
    return Promise.resolve(json(answer.body, answer.status ?? 200));
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
}

export const page = async (taskKey: string, answers: Answers): Promise<Mounted> => {
  const view = await mount(
    <TaskDetailScreen client={server(answers)} grantKey="alpha:member" taskKey={taskKey} />,
  );
  await tick();
  return view;
};

/** The one task, found under its own key. */
export const found = (over: Readonly<Record<string, unknown>> = {}): Answers => ({
  'Proj-Verity-Pacing': { body: { ok: true, task: task(over) } },
});

/** A data attribute on the one element a selector names. */
export const dataOf = (view: Mounted, selector: string, key: string): string | undefined =>
  view.host.querySelector<HTMLElement>(selector)?.dataset[key];
