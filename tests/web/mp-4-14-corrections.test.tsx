// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-14, the mockup's task defects kept out of the build (TASKS T19, XC D12,
// D19): a finished task's state is toned as done, never as running; its id
// prints exactly as typed; and nothing offers a Roll back that does nothing.
// These guard what the page and the panel already draw, so each is proved by
// planting the defect (the handback's undo log). Roll back drawn unavailable
// (R78), the agent's status select (R43), the staged output spill and the
// snapshot icon belong to the Agent pane (MP-6-1) and wait on it; the
// captures on MP-1-7.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskDetailScreen } from '../../apps/web/src/screens/TaskDetail.tsx';
import { mount, unmountAll } from './perspective-support.tsx';
import { tick } from './task-page-stub.tsx';
import { KEY, panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const COMPLETE = { id: 's5', key: 'complete', label: 'Complete', machineCategory: 'completed' };
const ACTIVE = { id: 's2', key: 'active', label: 'Active', machineCategory: 'started' };

const pageOf = async (over: Readonly<Record<string, unknown>>) => {
  const view = await mount(
    <TaskDetailScreen client={serving(over).client} grantKey="alpha:member" taskKey={KEY} />,
  );
  await tick();
  return view;
};

const toneOf = (view: Awaited<ReturnType<typeof pageOf>>): string | undefined =>
  view.host.querySelector<HTMLElement>('[data-crumb="state"] .spill')?.dataset['tone'];

describe('MP-4-14 complete is toned as done', () => {
  it('a finished task’s state is toned done, and a running one run', async () => {
    const done = await pageOf({ state: COMPLETE, completedAt: '2026-09-29T02:00:00.000Z' });
    expect(toneOf(done)).toBe('done');
    await done.unmount();
    const running = await pageOf({ state: ACTIVE });
    expect(toneOf(running)).toBe('run');
    await running.unmount();
  });
});

describe('MP-4-14 ids print as typed', () => {
  it('the key reads exactly as stored, and its style changes no letter’s case', async () => {
    const view = await pageOf({ key: 'Proj-Verity-Pacing' });
    expect(view.find('[data-crumb="key"]')?.textContent).toBe('Proj-Verity-Pacing');
    const css = readFileSync(
      join(import.meta.dirname, '../../packages/ui/src/styles/5-task.css'),
      'utf8',
    );
    const rules = [...css.matchAll(/\.sbact__meta\s*\{([^}]*)\}/gu)].map((match) => match[1]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(rule).not.toMatch(/text-transform/u);
    await view.unmount();
  });
});

describe('MP-4-14 no roll back that does nothing', () => {
  it('neither the page nor the panel of a finished task offers a live Roll back', async () => {
    const over = { state: COMPLETE, completedAt: '2026-09-29T02:00:00.000Z' };
    const views = [await pageOf(over), await panel(serving(over).client)];
    for (const view of views) {
      const live = view
        .all('button, a, [role="button"]')
        .filter((control) => /roll\s*back/iu.test(control.textContent ?? ''))
        .filter((control) => !(control as HTMLButtonElement).disabled);
      expect(live).toStrictEqual([]);
      // oxlint-disable-next-line no-await-in-loop
      await view.unmount();
    }
  });

  it.todo(
    'Roll back is drawn unavailable with the not-connected treatment (R78; the Agent pane, MP-6-1)',
  );
});

describe('MP-4-14 the agent’s status select offers On hold', () => {
  it.todo('On hold is offered and Complete stays with the board tick and the gate (R43; MP-6-1)');
});

describe('MP-4-14 staged output and the snapshot icon', () => {
  it.todo(
    'the PAUSED spill does not stretch the row and the snapshot icon sits on its line (MP-6-1, MP-1-7)',
  );
});
