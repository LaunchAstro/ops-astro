// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { mount } from '../surfaces/mount.tsx';

const step = (id: string, over: Partial<StepView> = {}): StepView => ({
  id,
  key: id,
  title: `Step ${id}`,
  state: null,
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 3,
  ...over,
});
const client = new OperationsClient({
  origin: '',
  businessKey: 'alpha',
  signedIn: true,
  fetch: () => {
    throw new Error('This read-only test must not send a command');
  },
});

it('keeps retired work visible, outside the completed fold and progress, with its owner and reason', async () => {
  const steps = [
    step('open'),
    step('done', { done: true }),
    step('retired', {
      archived: { at: '2026-10-08T02:00:00.000Z', why: 'The parent task was completed' },
      assignee: { personId: 'ada', name: 'Ada Lovelace' },
    }),
  ];
  const render = (showFinished: boolean) => (
    <SubtaskList
      client={client}
      parentId="parent"
      steps={steps}
      showFinished={showFinished}
      onShowFinished={() => {}}
      onChanged={() => {}}
    />
  );
  const view = await mount(render(false));
  expect(view.find('[data-step-count]')?.textContent).toBe('1 of 2 done · 50%');
  expect(view.find('[data-step="done"]')).toBeNull();
  expect(view.find('[data-step="retired"]')?.textContent).toContain(
    'The parent task was completed',
  );
  expect(view.find('[data-step="retired"] [role="checkbox"]')).toBeNull();
  expect(view.find('[data-step="retired"] [role="img"]')?.getAttribute('aria-label')).toBe(
    'Ada Lovelace',
  );
  expect(view.find('[data-steps-finished]')?.textContent).toBe('Show finished (1)');
  await view.render(render(true));
  expect(view.find('[data-step="done"]')).not.toBeNull();
  expect(view.all('[data-step="retired"]')).toHaveLength(1);
});

it('draws an owner on live steps, and the empty remainder when all live work is done', async () => {
  const steps = [step('done', { done: true, assignee: { personId: 'ada', name: 'Ada Lovelace' } })];
  const view = await mount(
    <SubtaskList
      client={client}
      parentId="parent"
      steps={steps}
      showFinished
      onShowFinished={() => {}}
      onChanged={() => {}}
    />,
  );
  expect(view.find('[data-step="done"] [role="img"]')?.getAttribute('aria-label')).toBe(
    'Ada Lovelace',
  );
  expect(view.text()).toContain('Nothing left on this one.');
});
