// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-4: the subtask list on the task page's Team side (CS-4.25 to CS-4.27).
// A subtask is a task: Enter adds one through `task.create` under this
// parent and the box stays ready for the next; a tick completes or reopens
// it through the one lifecycle each task has. The count and the percentage
// are the steps the server sent, redrawn from the reread, and the page's Team
// badge counts the same steps (MP-4-3's one rule).

import { act, useState, type ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { StepView } from '../../packages/core-wire/src/index.ts';
import { SubtaskList } from '../../apps/web/src/screens/task/Subtasks.tsx';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import type { Mounted } from '../surfaces/mount.tsx';
import { found, TASK_ID, tick } from './task-page-stub.tsx';
import { badge, json, mount, page, press, unmountAll } from './perspective-support.tsx';

afterEach(unmountAll);

interface Sent {
  readonly command: string;
  readonly body: Readonly<Record<string, unknown>>;
}

const step = (id: string, title: string, over: Partial<StepView> = {}): StepView => ({
  id,
  key: `T-${id}`,
  title,
  state: { id: `s-${id}`, key: 'active', label: 'Active', machineCategory: 'started' },
  done: false,
  archived: null,
  assignee: null,
  revision: 3,
  ...over,
});

const COPY = step('41', 'Write the copy');
const FORMS = step('42', 'Check the forms');
const DONE = step('43', 'Book the shoot', { done: true });
const ARCHIVED = step('44', 'Old plan', {
  archived: { at: '2026-09-30T02:00:00.000Z', why: 'The parent task was completed' },
});

/** Records each command; answers every one as applied. */
function commands() {
  const sent: Sent[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    const at = String(url);
    const command = at.slice(at.lastIndexOf('/b/alpha/') + 9).replace('/', '.');
    sent.push({
      command,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Sent['body'],
    });
    return Promise.resolve(json({ ok: true, recordId: 'new', revision: 4 }));
  }) as unknown as typeof globalThis.fetch;
  const client = new OperationsClient({ origin: '', businessKey: 'alpha', token: 'tok', fetch });
  return { client, sent };
}

/** The list under a parent that rereads on change: it redraws the server's next steps. */
async function list(client: OperationsClient, steps: readonly StepView[], next = steps) {
  const counter = { rereads: 0 };
  function Parent(): ReactElement {
    const [shown, setShown] = useState(steps);
    const [open, setOpen] = useState(false);
    return (
      <SubtaskList
        client={client}
        parentId={TASK_ID}
        steps={shown}
        showFinished={open}
        onShowFinished={setOpen}
        onChanged={() => {
          counter.rereads += 1;
          setShown(next);
        }}
      />
    );
  }
  const view = await mount(<Parent />);
  return { view, rereads: () => counter.rereads };
}

const typeInto = async (view: Mounted, value: string) => {
  const input = view.host.querySelector<HTMLInputElement>('input[data-step-add]');
  if (input === null) throw new Error('no add box');
  await act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
};

const click = async (view: Mounted, selector: string) => {
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

describe('MP-4-4 enter adds', () => {
  it('CS-4.25: Enter adds under this parent, clears the box and keeps it ready', async () => {
    const { client, sent } = commands();
    const added = step('45', 'Draft the brief');
    const { view, rereads } = await list(client, [COPY], [COPY, added]);
    const input = await typeInto(view, 'Draft the brief');
    input.focus();
    await press(view, 'input[data-step-add]', 'Enter');
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.command).toBe('task.create');
    expect(sent[0]?.body).toMatchObject({
      fields: { title: 'Draft the brief' },
      parentId: TASK_ID,
    });
    expect(rereads()).toBe(1);
    const box = view.host.querySelector<HTMLInputElement>('input[data-step-add]');
    expect(box?.value).toBe('');
    expect(document.activeElement).toBe(box);
    // The box sits at the top of the list and the new step joins at the end.
    expect(rows(view)).toStrictEqual(['41', '45']);
    const order = [...view.host.querySelectorAll('input[data-step-add], [data-step]')];
    expect(order[0]?.matches('input[data-step-add]')).toBe(true);
  });

  it('an empty box sends nothing', async () => {
    const { client, sent } = commands();
    const { view } = await list(client, [COPY]);
    await typeInto(view, '   ');
    await press(view, 'input[data-step-add]', 'Enter');
    await tick();
    expect(sent).toHaveLength(0);
  });
});

describe('MP-4-4 count updates', () => {
  it('CS-4.26: a tick completes the step through task.complete at its revision', async () => {
    const { client, sent } = commands();
    const { view } = await list(client, [COPY, FORMS], [{ ...COPY, done: true }, FORMS]);
    expect(view.find('[data-step-count]')?.textContent).toBe('0 of 2 done · 0%');
    await click(view, '[data-step-tick="41"]');
    expect(sent).toStrictEqual([
      {
        command: 'task.complete',
        body: expect.objectContaining({ recordId: '41', expectedRevision: 3 }) as never,
      },
    ]);
    expect(view.find('[data-step-count]')?.textContent).toBe('1 of 2 done · 50%');
  });

  it('unticking a finished step reopens it, saying why', async () => {
    const { client, sent } = commands();
    const { view } = await list(client, [COPY, DONE]);
    await click(view, '[data-steps-finished]');
    await click(view, '[data-step-tick="43"]');
    expect(sent[0]?.command).toBe('task.reopen');
    expect(sent[0]?.body).toMatchObject({ recordId: '43', expectedRevision: 3 });
    expect(typeof sent[0]?.body['reason']).toBe('string');
  });

  it('the page’s Team badge counts the steps the read carries', async () => {
    const view = await page('Proj-Verity-Pacing', found({ steps: [COPY, FORMS, DONE, ARCHIVED] }));
    expect(badge(view, 'team')).toBe('2');
    expect(view.find('[data-step-count]')?.textContent).toBe('1 of 3 done · 33%');
  });
});

describe('MP-4-4 completed fold', () => {
  it('finished steps fold away under a count, and the percentage stays', async () => {
    const { client } = commands();
    const { view } = await list(client, [COPY, DONE]);
    expect(rows(view)).toStrictEqual(['41']);
    const fold = view.find('[data-steps-finished]');
    expect(fold?.textContent).toBe('Show finished (1)');
    expect(fold?.getAttribute('aria-expanded')).toBe('false');
    expect(view.find('[data-step-count]')?.textContent).toBe('1 of 2 done · 50%');
  });
});

describe('MP-4-4 show finished', () => {
  it('CS-4.27: the fold shows and hides the finished steps', async () => {
    const { client } = commands();
    const { view } = await list(client, [COPY, DONE]);
    await click(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41', '43']);
    expect(view.find('[data-steps-finished]')?.getAttribute('aria-expanded')).toBe('true');
    expect(view.find('[data-steps-finished]')?.textContent).toBe('Hide finished');
    await click(view, '[data-steps-finished]');
    expect(rows(view)).toStrictEqual(['41']);
  });
});

describe('MP-4-4 archived shows why', () => {
  it('an archived step says when and why, carries no tick, and is out of the count', async () => {
    const { client } = commands();
    const { view } = await list(client, [COPY, ARCHIVED]);
    expect(view.find('[data-step-count]')?.textContent).toBe('0 of 1 done · 0%');
    await click(view, '[data-steps-finished]');
    const row = view.find('[data-step="44"]');
    expect(row?.textContent).toContain('Archived 30 Sept 2026');
    expect(row?.textContent).toContain('The parent task was completed');
    expect(view.find('[data-step-tick="44"]')).toBeNull();
  });
});

describe('MP-4-4 gate step no checkbox', () => {
  it.todo('a step waiting at a gate carries no tick (no gate-step marker on the read yet)');
});

describe('MP-4-4 note wraps at 640', () => {
  it.todo('a step note wraps at 640 and below without overlap (MP-1-7 harness)');
});

describe('MP-4-4 harness captures', () => {
  it.todo('the Team side at 1480, 900 and 390, light and dark (MP-1-7 harness)');
});
