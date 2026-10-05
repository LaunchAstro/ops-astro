// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable require-await -- Sol's proof, kept as written */

import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { json, mount, press, unmountAll } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

// Sol OW-092.1 criterion 5, retitled by what it proves; its body is Sol's.
it('retrying a subtask create after a lost committed response creates only one child', async () => {
  const committed = new Map<unknown, string>();
  const attempts: unknown[] = [];
  let changed = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async (_url, init) => {
      const body: { operationId: string; parentId: string; fields: { title: string } } = JSON.parse(
        String(init?.body),
      );
      expect(body.parentId).toBe(TASK_ID);
      expect(body.fields.title).toBe('Write the brief');
      attempts.push(body.operationId);
      // The server deduplicates by operationId, as the real command envelope does.
      if (!committed.has(body.operationId))
        committed.set(body.operationId, `child-${committed.size}`);
      if (attempts.length === 1) throw new Error('Connection lost after commit');
      return json({ recordId: committed.get(body.operationId), revision: 1 });
    },
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId={TASK_ID}
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {
        changed += 1;
      }}
    />,
  );
  await view.type('[data-step-add]', 'Write the brief');
  await press(view, '[data-step-add]', 'Enter');
  await tick();
  expect(view.text()).toContain('Connection lost after commit');
  expect(changed).toBe(0);
  await press(view, '[data-step-add]', 'Enter');
  await tick();
  expect(attempts).toHaveLength(2);
  expect(committed.size, 'a retry must replay the first committed create').toBe(1);
});
