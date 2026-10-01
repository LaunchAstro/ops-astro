// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4 (CS-4.27, `preference saved`): showing or hiding a task's finished
// subtasks is the person's own key in the one preference store, read once and
// saved on each change, on the task page and in the dock panel alike. A reader
// the store refuses keeps the choice for the view and sends no save.

import { act, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { useShowFinished } from '../../apps/web/src/screens/task/show-finished.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { TASK_ID, task, tick } from './task-page-stub.tsx';
import type { Mounted } from '../surfaces/mount.tsx';
import { json, mount, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

interface Sent {
  readonly call: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const step = (id: string, done: boolean): StepView => ({
  id,
  key: `T-${id}`,
  title: `Step ${id}`,
  state: { id: `s-${id}`, key: 'active', label: 'Active', machineCategory: 'started' },
  done,
  archived: null,
  awaitingApproval: false,
  assignee: null,
  revision: 3,
});

/** A client whose `preference.read` answers `read`; every write is recorded and applied. */
function client(read: Response | (() => Response | Promise<Response>)) {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const call = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    sent.push({
      call,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'],
    });
    if (call === 'preference.read')
      return Promise.resolve(typeof read === 'function' ? read() : read);
    if (call === 'task.read') {
      return Promise.resolve(
        json({ ok: true, task: task({ steps: [step('41', false), step('43', true)] }) }),
      );
    }
    if (call === 'person.list') return Promise.resolve(json({ ok: true, persons: [] }));
    return Promise.resolve(json({ ok: true, recordId: null, revision: null }));
  }) as unknown as typeof globalThis.fetch;
  return {
    client: new OperationsClient({ origin: '', businessKey: 'alpha', signedIn: true, fetch }),
    saves: () => sent.filter((each) => each.call === 'preference.save').map((each) => each.body),
  };
}

/** A `preference.read` answer the test hands over when it chooses. */
function later() {
  let settle: ((response: Response) => void) | undefined;
  const promise = new Promise<Response>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: (response: Response) => settle?.(response) };
}

/** The store refusing the reader (no grant). */
const refusal = () =>
  json({ ok: false, code: 'SCOPE_NOT_GRANTED', names: [], fixes: ['Ask for read.'] }, 403);

async function list(of: OperationsClient) {
  function Parent(): ReactElement {
    const [open, setOpen] = useShowFinished(of);
    return (
      <SubtaskList
        client={of}
        parentId={TASK_ID}
        steps={[step('41', false), step('43', true)]}
        showFinished={open}
        onShowFinished={setOpen}
        onChanged={() => null}
      />
    );
  }
  const view = await mount(<Parent />);
  await tick();
  return view;
}

const press = async (view: Mounted, selector: string) => {
  const target = view.host.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`nothing matches ${selector}`);
  await act(() => {
    target.click();
  });
  await tick();
};

const rows = (view: Mounted): readonly string[] =>
  [...view.host.querySelectorAll<HTMLElement>('[data-step]')].map(
    (row) => row.dataset['step'] ?? '',
  );

describe('MP-4-4 show finished, remembered per person', () => {
  it('CS-4.27: a stored choice opens the fold on arrival, and each change is saved as the person’s own key', async () => {
    const { client: of, saves } = client(
      json({ ok: true, preferences: { 'subtasks.showFinished': true } }),
    );
    const view = await list(of);
    expect(rows(view)).toStrictEqual(['41', '43']);
    await press(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41']);
    expect(saves()).toMatchObject([{ preference: 'subtasks.showFinished', value: false }]);
    expect(saves()[0]).not.toHaveProperty('personId');
  });

  it('CS-4.27: with nothing stored the fold starts closed, and opening it saves true', async () => {
    const { client: of, saves } = client(json({ ok: true, preferences: {} }));
    const view = await list(of);
    expect(rows(view)).toStrictEqual(['41']);
    await press(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41', '43']);
    expect(saves()).toMatchObject([{ preference: 'subtasks.showFinished', value: true }]);
  });

  it('a reader the store refuses still folds and unfolds, and sends no save', async () => {
    const { client: of, saves } = client(refusal);
    const view = await list(of);
    await press(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41', '43']);
    expect(saves()).toStrictEqual([]);
  });

  it('CS-4.27: the task page opens the fold from the stored choice and saves a change', async () => {
    const { client: of, saves } = client(
      json({ ok: true, preferences: { 'subtasks.showFinished': true } }),
    );
    const view = await mount(
      <TaskDetailScreen client={of} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
    );
    await tick();
    await tick();
    expect(rows(view)).toStrictEqual(['41', '43']);
    await press(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41']);
    expect(saves()).toMatchObject([{ preference: 'subtasks.showFinished', value: false }]);
  });
});

describe('MP-4-4 show finished, held through a slow store and a reread', () => {
  it('a click before the stored choice arrives stands, and is saved once the store answers', async () => {
    const late = later();
    const { client: of, saves } = client(() => late.promise);
    const view = await list(of);
    await press(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41', '43']);
    await act(async () => {
      late.resolve(json({ ok: true, preferences: { 'subtasks.showFinished': false } }));
      await late.promise;
    });
    await tick();
    expect(rows(view)).toStrictEqual(['41', '43']);
    expect(saves()).toMatchObject([{ preference: 'subtasks.showFinished', value: true }]);
  });

  for (const [reader, read] of [
    ['a reader the store keeps', () => json({ ok: true, preferences: {} })],
    ['a reader the store refuses', refusal],
  ] as const) {
    it(`the task page keeps the fold open across a reread, for ${reader}`, async () => {
      const { client: of } = client(read);
      const view = await mount(
        <TaskDetailScreen client={of} grantKey="alpha:member" taskKey="Proj-Verity-Pacing" />,
      );
      await tick();
      await tick();
      await press(view, '[data-steps-finished]');
      expect(rows(view)).toStrictEqual(['41', '43']);
      await press(view, '[data-refresh="task"]');
      await tick();
      expect(rows(view)).toStrictEqual(['41', '43']);
    });
  }
});
