// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Client field on its real sources (C32, S0-5): the choices are
// `client.list`'s clients, and the task's client and whether it has content
// (the lock) are `task.read`'s `client` and `hasContent`. A real source draws
// no Mock label. The form and the made-up duplicate are `mp-4-8-client.test.tsx`'s.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const A = { id: 'c-a', name: 'Acme Physio' };
const B = { id: 'c-b', name: 'Birch Dental' };
const LINE =
  'This task has content, so its client is locked. Duplicate it without contents to start one for another client.';
/** A task with a subtask, which the server still answers empty: its word decides. */
const SHELL = {
  title: 'Acme Physio budget pacing fix',
  steps: [
    {
      id: 's1',
      key: 'K-s1',
      title: 'Pull the spend report',
      state: null,
      done: false,
      archived: null,
      awaitingApproval: false,
      assignee: null,
      revision: 1,
    },
  ],
};

describe('MP-4-8 client field reads the real clients and the task’s client', () => {
  const LISTED = [
    { clientId: A.id, name: A.name },
    { clientId: B.id, name: B.name },
  ];
  const real = (over: Readonly<Record<string, unknown>>) => serving(over, [], [], [], LISTED);

  it('lists client.list’s clients, selects the task’s client, and carries no Mock label', async () => {
    const { client, sent } = real({ client: B.id, clientSet: true, hasContent: false });
    const view = await panel(client);
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect([...(select?.options ?? [])].map((option) => option.text)).toStrictEqual([
      'No client',
      'Acme Physio',
      'Birch Dental',
    ]);
    expect(select?.value).toBe(B.id);
    expect(select?.disabled).toBe(false);
    expect(view.find('[data-panel-field="client"] .mocktag')).toBeNull();
    await view.choose('#panel-field-client', A.id);
    await tick();
    expect(sent.map((one) => [one.to, one.body['fields']])).toStrictEqual([
      ['/task/set_party', { client: A.id }],
    ]);
    await view.unmount();
  });

  it('a task that task.read says has content is drawn locked, whatever its subtasks', async () => {
    const { client, sent } = real({ client: A.id, clientSet: true, hasContent: true, steps: [] });
    const view = await panel(client);
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect(select?.disabled).toBe(true);
    expect(select?.value).toBe(A.id);
    expect(view.text()).toContain(LINE);
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });

  it('a task under no client reads No client and is open to a choice', async () => {
    const { client } = real({ client: null, clientSet: false, hasContent: false, ...SHELL });
    const view = await panel(client);
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect(select?.value).toBe('');
    expect(select?.disabled).toBe(false);
    expect(view.text()).not.toContain(LINE);
    await view.unmount();
  });
});
