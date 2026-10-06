// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { panel } from './panel-fields-support.tsx';
import { json, unmountAll } from './perspective-support.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

// Sol OW-092.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('a successful reopen refreshes the task even when the following state write is stale', async () => {
  const done = { id: 's-done', key: 'complete', label: 'Complete', machineCategory: 'completed' };
  const review = {
    id: 's-review',
    key: 'review',
    label: 'Needs review',
    machineCategory: 'unstarted',
  };
  const hold = { id: 's-hold', key: 'hold', label: 'On hold', machineCategory: 'backlog' };
  let current = task({ state: done, completedAt: '2026-09-30T10:00:00Z' });
  const sent: string[] = [];
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (url) => {
      const path = String(url);
      if (path.endsWith('/task/read')) return json({ task: current, states: [review, hold, done] });
      if (path.endsWith('/person/list')) return json({ persons: [] });
      if (path.endsWith('/task/board')) return json({ tasks: [] });
      if (path.endsWith('/tag/list')) return json({ tags: [] });
      if (path.endsWith('/client/list')) return json({ clients: [] });
      if (path.endsWith('/preference/read')) return json({ preferences: {} });
      if (path.endsWith('/task/reopen')) {
        sent.push('reopen');
        current = task({ state: review, completedAt: null, revision: 5 });
        return json({ recordId: TASK_ID, revision: 5 });
      }
      if (path.endsWith('/task/set_state')) {
        sent.push('set_state');
        // A concurrent edit after reopening makes this second command stale.
        current = { ...current, revision: 6 };
        return json({ refused: true, code: 'VERSION_STALE', names: [], fixes: [] }, 409);
      }
      return new Response(null, { status: 404 });
    },
  });
  let changed = 0;
  const view = await panel(client, {
    changed: () => {
      changed += 1;
    },
  });
  await view.choose('#panel-field-status', hold.id);
  await tick();
  expect(sent).toEqual(['reopen', 'set_state']);
  expect(current.completedAt).toBeNull();
  expect(view.text()).toContain('VERSION_STALE');
  expect(changed, 'the first command committed and the host must reread it').toBeGreaterThan(0);
});
