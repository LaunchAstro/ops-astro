// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { commands, list } from './subtask-actions-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';
const COPY: StepView = {
  id: '41',
  key: 'T-41',
  title: 'Write the copy',
  state: { id: 's-41', key: 'active', label: 'Active', machineCategory: 'started' },
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 3,
};
it('late removal and restore settle into their original parent after the drawer closes', async () => {
  let finish: (() => void) | undefined;
  let held: Promise<void> | null = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const server = commands(() => held ?? Promise.resolve());
  const old = await list(server.client, [COPY]);
  await old.view.click('[data-step-remove="41"]');
  await old.view.unmount();
  await act(() => {
    finish?.();
  });
  await tick();
  const reopened = await list(server.client, []);
  expect(reopened.view.find('[data-step-undo]')).not.toBeNull();
  expect(old.rereads()).toBe(0);
  held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await reopened.view.click('[data-step-undo]');
  await reopened.view.unmount();
  await act(() => {
    finish?.();
  });
  await tick();
  held = null;
  const restored = await list(server.client, [COPY]);
  expect(restored.view.find('[data-step-undo]')).toBeNull();
  expect(reopened.rereads()).toBe(0);
});

it('the subtask list can render on the server with its scoped receipt snapshot', () => {
  const server = commands();
  const markup = renderToString(
    <SubtaskList
      client={server.client}
      parentId={TASK_ID}
      steps={[COPY]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(markup).toContain('Write the copy');
});
