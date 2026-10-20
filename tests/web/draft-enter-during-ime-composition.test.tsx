// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
import { act } from 'react';
import { afterEach, expect, it } from 'vitest';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { draft } from './draft-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';
import { mount, typeInto, unmountAll } from './perspective-support.tsx';
import { TASK_ID, tick } from './task-page-stub.tsx';

afterEach(unmountAll);

/** Enter as an input method sends it to confirm the word being composed. */
const composingEnter = async (view: Mounted, selector: string): Promise<void> => {
  const field = view.host.querySelector(selector);
  if (field === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await tick();
};

// Sol OW-089.3 criterion correctness, retitled by what it proves; its body is Sol's.
it('Enter that commits IME composition does not add an unfinished tag', async () => {
  const { view } = await draft();
  await typeInto(view, '#panel-draft-tags', '未確定');
  const field = view.host.querySelector<HTMLInputElement>('#panel-draft-tags');
  expect(field).not.toBeNull();
  await act(() => {
    field?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(view.all('[data-draft-tag]')).toHaveLength(0);
  expect(field?.value).toBe('未確定');
});

it('Enter that commits IME composition in a filed task’s tags adds no tag', async () => {
  const { client, sent } = serving({}, [{ id: 'g-launch', name: 'Launch' }]);
  const view = await panel(client);
  view.host.querySelector<HTMLInputElement>('#panel-tag-input')?.focus();
  await tick();
  await typeInto(view, '#panel-tag-input', 'Lau');
  await composingEnter(view, '#panel-tag-input');
  expect(sent).toStrictEqual([]);
});

it('Enter that commits IME composition in a subtask box creates no subtask', async () => {
  let sent = 0;
  const client = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: () => {
      sent += 1;
      return Promise.resolve(new Response(null, { status: 503 }));
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
  await view.type('[data-step-add]', '未確定');
  await composingEnter(view, '[data-step-add]');
  expect(sent).toBe(0);
});
