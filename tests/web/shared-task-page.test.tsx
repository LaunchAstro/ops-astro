// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `/task/:key` for the external party (R4), against a stand-in that answers
// `task.read` the way the API does for a reader outside the business: under
// `sharedTask`, never `task` (`packages/core-records/src/reads/dispatch.ts`).
//
// The page used to read `value.task` whatever arrived, threw on the shared
// answer and drew nothing. These cases hold the three things that replaced it:
// the shared view draws the projection and nothing else, it offers no control
// and asks for nothing more, and a member still gets the whole page. The last
// case is the revocation: the next read is refused and the shared content goes
// with it.

import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';

const TASK_ID = '33333333-3333-4333-8333-333333333333';

const CLIENT_COMMENT = {
  id: 'c1',
  audience: 'client',
  body: 'A message the client may read.',
  comment_type: 'client',
  posted_at: '2026-09-23T01:00:00.000Z',
};

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

const REFUSED = {
  refused: true,
  code: 'NOT_FOUND',
  names: ['task'],
  fixes: ['check the address', 'ask the business to share it again'],
};

/** Every call the page makes, and the answer `task.read` gives next. */
function server(first: unknown) {
  const calls: string[] = [];
  let answer: { readonly body: unknown; readonly status: number } = { body: first, status: 200 };
  const fetch = (async (url: string | URL) => {
    const at = String(url);
    calls.push(at.slice(at.lastIndexOf('/b/alpha/') + 9));
    if (at.endsWith('/task/read')) return json(answer.body, answer.status);
    if (at.endsWith('/person/list')) return json({ ok: true, persons: [] });
    throw new Error(`unrouted ${at}`);
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    calls,
    answerNext: (body: unknown, status: number) => {
      answer = { body, status };
    },
  };
}

const screen = (fetch: typeof globalThis.fetch) => (
  <TaskDetailScreen
    client={new OperationsClient({ base: '/api', businessKey: 'alpha', token: 'tok', fetch })}
    grantKey="alpha:ext"
    taskKey={TASK_ID}
  />
);

const shared = (fields: Record<string, unknown>) => ({
  ok: true,
  sharedTask: { id: TASK_ID, fields, comments: [CLIENT_COMMENT] },
});

describe('the task page for a reader outside the business', () => {
  it('draws the shared projection: its fields under their keys and the client comments', async () => {
    const api = server(shared({ summary: 'What the client was told', budget: null }));
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-task-view="shared"]')?.getAttribute('data-task')).toBe(TASK_ID);
    expect(page.find('[data-shared-field="summary"]')?.textContent).toContain(
      'What the client was told',
    );
    expect(page.find('[data-shared-field="budget"]')?.textContent).toContain('No value');
    const rows = page.all('[data-comment-id]');
    expect(rows).toHaveLength(1);
    expect(page.text()).toContain('A message the client may read.');
    await page.unmount();
  });

  it('says so when no field is shared, rather than drawing an empty task', async () => {
    const api = server(shared({}));
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.all('[data-shared-field]')).toHaveLength(0);
    expect(page.text()).toContain('No field on this task is shared.');
    await page.unmount();
  });

  it('offers no control and reads nothing beyond task.read', async () => {
    const api = server(shared({ summary: 'Shared' }));
    const page = await mount(screen(api.fetch));
    await tick();

    const region = page.find('[data-task]');
    expect(region?.querySelectorAll('button, input, textarea, select')).toHaveLength(0);
    expect(page.find('#task-comment')).toBeNull();
    expect(page.find('[data-comment="post"]')).toBeNull();
    // No title, state, revision or history is on the page, because none came.
    expect((region as HTMLElement | null)?.dataset['revision']).toBeUndefined();
    expect(page.text()).not.toContain('History');
    // The member page reads the people list for assignment. This one must not
    // go looking for anything the projection did not carry.
    expect(api.calls).toEqual(['task/read']);
    await page.unmount();
  });

  it('draws the denied state and none of the shared content once the share is revoked', async () => {
    const api = server(shared({ summary: 'Shared before the revoke' }));
    const page = await mount(screen(api.fetch));
    await tick();
    expect(page.text()).toContain('A message the client may read.');

    api.answerNext(REFUSED, 404);
    await page.click('[data-refresh="task"]');
    await tick();

    expect(page.find('[data-outcome="denied"]')).not.toBeNull();
    expect(page.find('[data-task]')).toBeNull();
    expect(page.text()).not.toContain('A message the client may read.');
    expect(page.text()).not.toContain('Shared before the revoke');
    await page.unmount();
  });
});

describe('the task page for a member', () => {
  it('is still the whole page when task.read answers task', async () => {
    const api = server({
      ok: true,
      task: {
        id: TASK_ID,
        key: 'TSK-3',
        title: 'The whole task',
        description: null,
        state: { id: 's1', key: 'active', label: 'Active', machineCategory: 'started' },
        assignee: null,
        due: null,
        priority: null,
        completedAt: null,
        revision: 2,
        history: [],
        comments: [CLIENT_COMMENT],
        proposals: [],
      },
    });
    const page = await mount(screen(api.fetch));
    await tick();

    expect(page.find('[data-task-view="shared"]')).toBeNull();
    expect((page.find('[data-task]') as HTMLElement | null)?.dataset['revision']).toBe('2');
    expect(page.find('#task-comment')).not.toBeNull();
    expect(page.text()).toContain('History');
    await page.unmount();
  });
});
