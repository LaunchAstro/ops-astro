// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Status select (CS-4.18, DP-25; Stage 1 adds): the dock panel and
// the task page offer the business's task states as `task.read` sends them,
// in the workflow's order, and send the chosen state's id through
// `task.set_state` at the revision read. Complete is the one completion
// transition, `task.complete` (MP-4-13); leaving Complete is `task.reopen`
// first, which lands in the unstarted state, then `task.set_state` at the
// revision the reopen answered, unless the unstarted state was the choice.
// The server side (refusals, audit, crossings) is task.set_state's own suites.

import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
import { KEY, panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const STATES = [
  { id: 's-review', key: 'needs_review', label: 'Needs review', machineCategory: 'unstarted' },
  { id: 's-active', key: 'active', label: 'Active', machineCategory: 'started' },
  {
    id: 's-wait',
    key: 'waiting_on_client',
    label: 'Waiting on client',
    machineCategory: 'started',
  },
  { id: 's-hold', key: 'on_hold', label: 'On hold', machineCategory: 'backlog' },
  { id: 's-done', key: 'complete', label: 'Complete', machineCategory: 'completed' },
];
const [REVIEW, ACTIVE, , HOLD, DONE] = STATES;

const at = (state: (typeof STATES)[number] | undefined, completedAt: string | null = null) =>
  serving({ state, completedAt }, [], [], STATES);

const optionsOf = (select: HTMLSelectElement | null) =>
  [...(select?.options ?? [])].map((option) => [option.value, option.text]);

const commands = (sent: ReturnType<typeof serving>['sent']) =>
  sent.map((one) => {
    const { operationId: _unread, ...body } = one.body;
    return [one.to, body];
  });

describe('MP-4-8 Status select on the dock panel', () => {
  it('offers the business’s states in the workflow’s order with the task’s state chosen', async () => {
    const view = await panel(at(HOLD).client);
    const select = view.find('#panel-field-status') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual(STATES.map((one) => [one.id, one.label]));
    expect(select?.value).toBe('s-hold');
    await view.unmount();
  });

  it('a state that is not Complete goes through task.set_state at the read revision', async () => {
    const { client, sent } = at(ACTIVE);
    const view = await panel(client);
    await view.choose('#panel-field-status', 's-wait');
    await tick();
    expect(commands(sent)).toStrictEqual([
      ['/task/set_state', { recordId: TASK_ID, stateId: 's-wait', expectedRevision: 4 }],
    ]);
    await view.unmount();
  });
});

describe('MP-4-8 Status select: Complete is the one completion transition', () => {
  it('Complete is the one completion transition, task.complete, never task.set_state', async () => {
    const { client, sent } = at(ACTIVE);
    const view = await panel(client);
    await view.choose('#panel-field-status', 's-done');
    await tick();
    expect(commands(sent)).toStrictEqual([
      ['/task/complete', { recordId: TASK_ID, expectedRevision: 4 }],
    ]);
    await view.unmount();
  });

  it('leaving Complete reopens first, then sets the chosen state at the reopen’s revision', async () => {
    const { client, sent } = at(DONE, '2026-09-30T10:00:00Z');
    const view = await panel(client);
    await view.choose('#panel-field-status', 's-hold');
    await tick();
    await tick();
    expect(commands(sent)).toStrictEqual([
      [
        '/task/reopen',
        { recordId: TASK_ID, reason: 'Reopened from the status select.', expectedRevision: 4 },
      ],
      ['/task/set_state', { recordId: TASK_ID, stateId: 's-hold', expectedRevision: 5 }],
    ]);
    await view.unmount();
  });

  it('leaving Complete for the unstarted state is the reopen alone', async () => {
    const { client, sent } = at(DONE, '2026-09-30T10:00:00Z');
    const view = await panel(client);
    await view.choose('#panel-field-status', REVIEW?.id ?? '');
    await tick();
    await tick();
    expect(commands(sent).map(([to]) => to)).toStrictEqual(['/task/reopen']);
    await view.unmount();
  });

  it('a task whose state is not among the states read keeps it as itself', async () => {
    const odd = { id: 's-odd', key: 'legacy', label: 'Legacy', machineCategory: 'started' };
    const view = await panel(serving({ state: odd }, [], [], STATES).client);
    const select = view.find('#panel-field-status') as HTMLSelectElement | null;
    expect(optionsOf(select).at(-1)).toStrictEqual(['s-odd', 'Legacy']);
    expect(select?.value).toBe('s-odd');
    await view.unmount();
  });
});

describe('MP-4-8 Status select on the task page', () => {
  it('offers the same states and sends the same command as the panel', async () => {
    const { client, sent } = at(ACTIVE);
    const view = await mount(
      <TaskDetailScreen client={client} grantKey="alpha:member" taskKey={KEY} />,
    );
    await tick();
    const select = view.find('#task-field-status') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual(STATES.map((one) => [one.id, one.label]));
    expect(select?.value).toBe('s-active');
    await view.choose('#task-field-status', 's-hold');
    await tick();
    expect(commands(sent)).toStrictEqual([
      ['/task/set_state', { recordId: TASK_ID, stateId: 's-hold', expectedRevision: 4 }],
    ]);
    await view.unmount();
  });
});
