// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Client field on the real seams, the two cases the made-up ones hid:
// a task under a client the reader's grants do not reach (`task.read` sends
// `client` null beside `clientSet`, CS-4.12), and "Duplicate without
// contents" sent as `task.duplicate` when the host hands the panel no sender.

import { afterEach, describe, expect, it } from 'vitest';
import { tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const A = { clientId: 'c-a', name: 'Acme Physio' };
const B = { clientId: 'c-b', name: 'Birch Dental' };
const step = (id: string, title: string) => ({
  id,
  key: `K-${id}`,
  title,
  state: null,
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 1,
});
const SHELL = {
  title: 'Budget pacing fix',
  steps: [step('s1', 'Pull the spend report'), step('s2', 'Email the summary')],
};

describe('MP-4-8 a client the reader cannot see', () => {
  it('a task under a client the reader’s grants do not reach reads A client you cannot see', async () => {
    const over = { client: null, clientSet: true, hasContent: true, steps: [] };
    const view = await panel(serving(over, [], [], [], [A, B]).client);
    const select = view.find('#panel-field-client') as HTMLSelectElement | null;
    expect(select?.selectedOptions[0]?.text).toBe('A client you cannot see');
    expect(select?.disabled).toBe(true);
    await view.unmount();
  });
});

describe('MP-4-8 the panel’s own duplicate', () => {
  it('the panel’s own duplicate sends task.duplicate and carries no Mock label', async () => {
    const over = { ...SHELL, client: A.clientId, clientSet: true, hasContent: true };
    const { client, sent } = serving(over, [], [], [], [A, B]);
    const view = await panel(client);
    await view.click('[data-panel-field="duplicate"]');
    expect(view.all('.mocktag')).toStrictEqual([]);
    await view.choose('#duplicate-client', B.clientId);
    await view.click('[data-duplicate="create"]');
    await tick();
    const posted = sent.filter((one) => one.to === '/task/duplicate').map((one) => one.body);
    expect(posted).toStrictEqual([
      expect.objectContaining({
        client: B.clientId,
        title: SHELL.title,
        stepNames: SHELL.steps.map((one) => one.title),
        confirmCarried: false,
      }),
    ]);
    await view.unmount();
  });
});
