// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable consistent-function-scoping, max-lines-per-function -- Sol's proof, kept as written */

import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { TimeLog } from '../../apps/web/src/screens/task/Time.tsx';
import { json, mount, press, typeInto, unmountAll } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

// Sol OW-092.2 criterion 5, retitled by what it proves; its body is Sol's.
it('a delayed subtask create response does not erase text typed for the next child', async () => {
  let answer: (value: Response) => void = () => {
    throw new Error('request not started');
  };
  const pending = new Promise<Response>((resolve) => {
    answer = resolve;
  });
  let sent = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async () => {
      sent += 1;
      return await pending;
    },
  });
  const view = await mount(
    <SubtaskList
      client={client}
      parentId={TASK_ID}
      steps={[]}
      showFinished={false}
      onShowFinished={() => {}}
      onChanged={() => {}}
    />,
  );
  await view.type('[data-step-add]', 'First child');
  await press(view, '[data-step-add]', 'Enter');
  expect(sent).toBe(1);
  const input = view.host.querySelector<HTMLInputElement>('[data-step-add]');
  expect(input).not.toBeNull();
  if (input?.disabled) {
    await act(async () => {
      answer(json({ recordId: 'first-child', revision: 1 }));
      await pending;
    });
    await tick();
    await view.type('[data-step-add]', 'Second child');
    expect(input.value).toBe('Second child');
    return;
  }
  await view.type('[data-step-add]', 'Second child');
  expect(input?.value).toBe('Second child');
  await act(async () => {
    answer(json({ recordId: 'first-child', revision: 1 }));
    await pending;
  });
  await tick();
  expect(input?.value, 'the response belongs to First child, not the newer draft').toBe(
    'Second child',
  );
});

// Sol OW-093.2 criterion 5, retitled by what it proves; its body is Sol's.
it('a time-log acknowledgement preserves a newer unsent duration', async () => {
  let release: ((response: Response) => void) | undefined;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: async () =>
      await new Promise<Response>((resolve) => {
        release = resolve;
      }),
  });
  const view = await mount(
    <TimeLog
      client={client}
      taskId="task"
      time={{ entries: [], running: null, totalMinutes: 0 }}
      estimateMinutes={null}
      showAll={false}
      onShowAll={() => {}}
      onChanged={() => {}}
    />,
  );
  await typeInto(view, 'input[data-time-log]', '30m');
  await view.click('[data-time-log-add]');
  expect(view.find('[data-time-log-add]')?.hasAttribute('disabled')).toBe(true);
  const input = view.host.querySelector<HTMLInputElement>('input[data-time-log]');
  if (input === null) throw new Error('missing log input');
  // A writable box permits the person to prepare the next entry while waiting.
  const writable = !input.disabled && !input.readOnly;
  if (writable) await typeInto(view, 'input[data-time-log]', '15m');
  await act(() => {
    release?.(json({ recordId: null, revision: null }));
  });
  await tick();
  expect(input.value).toBe(writable ? '15m' : '');
});
