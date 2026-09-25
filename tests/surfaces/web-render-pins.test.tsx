// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Rendered-output pins for the web refactors (thermo review H8, H9, M12-M15).
//
// Those rows move code without meaning to change a single byte of what a
// person sees. The existing surface tests assert the parts that carry meaning;
// these pin the whole of the markup, so a moved component, a shared write
// state or a looked-up route that changes an attribute, a class or a disabled
// control shows here as a diff rather than passing unnoticed.
//
// The task page is pinned with its gate pending, decided and expired, and after
// the three writes whose settlement the refactor shares: a refused comment, a
// stale save and a refused decision. The board is pinned with a task in every
// machine category and one with no state, because the tone map moves too.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { Projects } from '../../apps/web/src/screens/Projects.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount, type Mounted } from './mount.tsx';

const pause = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

const tick = async (): Promise<void> => {
  await act(async () => {
    await pause();
    await pause();
    await pause();
  });
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A keystroke into the comment box, which is a textarea and has its own setter. */
async function typeComment(page: Mounted, value: string): Promise<void> {
  const field = page.find('#comment-body') as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const refused = (code: string, status: number): Response =>
  json({ refused: true, code, names: ['task'], fixes: ['Read the task again.'] }, status);

const TASK_ID = '44444444-4444-4444-8444-444444444444';

function taskWith(gate: { readonly state: string; readonly expired: boolean }) {
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
    history: [{ at: '2026-09-22T01:00:00.000Z', actorId: 'p-1', operation: 'task.create' }],
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
function taskServer(
  gate: { readonly state: string; readonly expired: boolean },
  writes: Readonly<Record<string, Response>> = {},
) {
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    if (at.endsWith('/person/list')) {
      return json({ ok: true, persons: [{ personId: 'p-1', name: 'Ada' }] });
    }
    if (at.endsWith('/task/read')) return json({ ok: true, task: taskWith(gate) });
    for (const [suffix, response] of Object.entries(writes)) {
      if (at.endsWith(suffix)) return response.clone();
    }
    return refused('NOT_FOUND', 404);
  }) as unknown as typeof globalThis.fetch;
  return new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    token: 'a-token',
    fetch,
    newOperationId: () => 'operation-1',
  });
}

const taskPage = async (client: OperationsClient): Promise<Mounted> => {
  const page = await mount(
    <TaskDetailScreen client={client} grantKey="alpha:ada" taskKey="TSK-41" />,
  );
  await tick();
  return page;
};

describe('the task page, pinned whole', () => {
  for (const [name, gate] of [
    ['pending', { state: 'pending', expired: false }],
    ['decided', { state: 'approved', expired: false }],
    ['expired', { state: 'expired', expired: true }],
  ] as const) {
    it(`draws a ${name} gate`, async () => {
      const page = await taskPage(taskServer(gate));
      expect(page.host.innerHTML).toMatchSnapshot();
      await page.unmount();
    });
  }

  it('after a comment refused for want of the grant', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/comment': refused('SCOPE_NOT_GRANTED', 403) },
    );
    const page = await taskPage(client);
    await typeComment(page, 'Hello');
    await page.click('[data-comment="post"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });

  it('after a save refused as stale, with the draft held', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/update': refused('VERSION_STALE', 409) },
    );
    const page = await taskPage(client);
    await page.type('#task-title', 'A newer title');
    expect(page.host.innerHTML).toMatchSnapshot('dirty');
    await page.click('[data-draft-resolve="save"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot('conflict');
    await page.unmount();
  });

  it('after a lifecycle write refused', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/start': refused('TRANSITION_PROTECTED', 409) },
    );
    const page = await taskPage(client);
    await page.click('[data-lifecycle="start"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });

  it('after a decision refused', async () => {
    const client = taskServer(
      { state: 'pending', expired: false },
      { '/task/decide': refused('SCOPE_NOT_GRANTED', 403) },
    );
    const page = await taskPage(client);
    await page.click('[data-decide="approve"]');
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });
});

describe('the board, pinned whole', () => {
  it('draws a task in every machine category and one with no state', async () => {
    const categories = ['unstarted', 'started', 'backlog', 'completed', 'cancelled', 'invented'];
    const tasks = [
      ...categories.map((category, index) => ({
        id: `t-${String(index)}`,
        key: `TSK-${String(index)}`,
        title: `A ${category} task`,
        state: {
          id: `s-${category}`,
          key: category,
          label: `L-${category}`,
          machineCategory: category,
        },
        assignee: null,
        due: null,
        revision: 1,
      })),
      {
        id: 't-none',
        key: 'TSK-none',
        title: 'A task with no state',
        state: null,
        assignee: { personId: 'p-1', name: 'Ada' },
        due: '2020-01-01T00:00:00.000Z',
        revision: 1,
      },
    ];
    const fetch = (async (url: string | URL) =>
      String(url).endsWith('/task/board')
        ? json({ ok: true, tasks })
        : refused('NOT_FOUND', 404)) as unknown as typeof globalThis.fetch;
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      token: 'a-token',
      fetch,
      newOperationId: () => 'operation-1',
    });
    const page = await mount(<Projects client={client} grantKey="alpha:ada" />);
    await tick();
    expect(page.host.innerHTML).toMatchSnapshot();
    await page.unmount();
  });
});
