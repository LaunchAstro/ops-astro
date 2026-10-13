// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.read` keeps a task's assignee after their business access ends, while
// `person.list` names active members only. The assignee pickers on the page and
// in the panel still show that person, as a former member, so the select is not
// blank and choosing Unassigned is a real change that clears them.

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternalTaskDetail, PersonListResult } from '../../packages/core-wire/src/index.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Assignee } from '../../apps/web/src/screens/task/Lifecycle.tsx';
import { AssigneeField } from '../../apps/web/src/screens/task/AssigneeField.tsx';
import type { useTaskAssignment } from '../../apps/web/src/screens/task/assignment-context.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';
import { task, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

const PEOPLE: PersonListResult = {
  ok: true,
  persons: [{ personId: 'reviewer', name: 'Riley Reviewer' }],
};
const FORMER = { personId: 'former', name: 'Fran Former' };

const chooseUnassigned = async (view: Mounted): Promise<void> => {
  await view.click('.sel__btn');
  const option = view.all('[role="option"]').find((each) => each.textContent === 'Unassigned');
  if (!(option instanceof HTMLElement)) throw new Error('no Unassigned option');
  await act(() => {
    option.click();
  });
};

describe('a task assigned to someone whose access ended', () => {
  it('the page picker shows them as a former member and Unassigned clears them', async () => {
    const onAssign = vi.fn();
    const view = await mount(
      <Assignee
        people={{ outcome: 'ready', value: PEOPLE, refusal: null, because: null, grantKey: 'g' }}
        onRetry={() => {}}
        assignee={FORMER}
        disabled={false}
        onAssign={onAssign}
      />,
    );
    expect(view.find('.sel__value')?.textContent).toBe('Fran Former (former member)');
    await chooseUnassigned(view);
    expect(onAssign).toHaveBeenCalledWith('');
  });

  it('the panel picker shows them as a former member and Unassigned clears them', async () => {
    const client = new OperationsClient({
      origin: '',
      businessKey: 'alpha',
      signedIn: true,
      fetch: () => Promise.resolve(json(PEOPLE)),
    });
    const choose = vi.fn(() => Promise.resolve());
    const assignment = { locked: false, custody: { choose } } as unknown as ReturnType<
      typeof useTaskAssignment
    >;
    const view = await mount(
      <AssigneeField
        client={client}
        task={task({ assignee: FORMER }) as unknown as InternalTaskDetail}
        grantKey="g"
        busy={false}
        assignment={assignment}
      />,
    );
    await tick();
    expect(view.find('.sel__value')?.textContent).toBe('Fran Former (former member)');
    await chooseUnassigned(view);
    expect(choose).toHaveBeenCalledWith(expect.any(String), 4, { assignee: null });
  });
});
