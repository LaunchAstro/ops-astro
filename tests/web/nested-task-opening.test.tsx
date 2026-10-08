// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { expect, it } from 'vitest';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { StepRow } from '../../apps/web/src/screens/task/SubtaskRows.tsx';
import { pathTo } from '../../apps/web/src/routes.ts';
import { mount } from '../surfaces/mount.tsx';

const child: StepView = {
  id: '11111111-1111-4111-8111-111111111111',
  key: 'nested-child',
  title: 'Child task',
  state: null,
  done: false,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 3,
};

it('opens a child by pointer and keyboard without ticking it, and leaves modified clicks native', async () => {
  const opened: string[] = [];
  const ticks: string[] = [];
  const view = await mount(
    <StepRow
      step={child}
      busy={false}
      onTick={(s) => ticks.push(s.id)}
      onOpenTask={(key) => opened.push(key)}
    />,
  );
  const link = view.find('a.sb__step-title');
  expect(link?.getAttribute('href')).toBe(pathTo('agency:task-detail', { key: child.key }));
  await view.click('a.sb__step-title');
  await act(() => {
    link?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  expect(opened).toStrictEqual([child.key, child.key]);
  expect(ticks).toStrictEqual([]);
  await act(() => {
    for (const modifiers of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...modifiers });
      link?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });
  expect(opened).toHaveLength(2);
  await view.click('[role="checkbox"]');
  expect(ticks).toStrictEqual([child.id]);
});

it.each([
  { ...child, awaitingApproval: true },
  { ...child, archived: { at: '2026-10-08T00:00:00Z', why: 'Finished parent' } },
])('keeps a gated or archived child door without offering a tick', async (step) => {
  const opened: string[] = [];
  const view = await mount(
    <StepRow
      step={step}
      busy={true}
      onTick={() => {
        throw new Error('Forbidden tick');
      }}
      onOpenTask={(key) => opened.push(key)}
    />,
  );
  expect(view.find('[role="checkbox"]')).toBeNull();
  await view.click('a.sb__step-title');
  expect(opened).toStrictEqual([child.key]);
});

it('provides the canonical child page address when no dock host is available', async () => {
  const view = await mount(
    <StepRow
      step={child}
      busy={false}
      onTick={() => {
        throw new Error('Read only');
      }}
    />,
  );
  expect(view.find('a.sb__step-title')?.getAttribute('href')).toBe(
    pathTo('agency:task-detail', { key: child.key }),
  );
});
