// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8, the dock task panel's field edits: the name, the assignee and the
// due date, each through the task's own command (`task.update` for the name
// and the due date, `task.assign` for the assignee) at the revision the panel
// read. Estimate, category, stage, board, state, Assign to AI and the client
// wait on other owners (the handback's LEANS-ON line); the server side of these
// edits (refusals, audit, isolation) is tests/commands/task-panel-fields.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, tick } from './task-page-stub.tsx';
import { press, typeInto, unmountAll } from './perspective-support.tsx';
import { PEOPLE, panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

describe('MP-4-8 rename updates everywhere', () => {
  it('the name is changed in place through task.update at the read revision, and the host rereads', async () => {
    const { client, sent } = serving();
    let changed = 0;
    const view = await panel(client, { changed: () => (changed += 1) });
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', 'Budget pacing fix, round two');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('/task/update');
    expect(sent[0]?.body).toMatchObject({
      recordId: TASK_ID,
      expectedRevision: 4,
      fields: { title: 'Budget pacing fix, round two' },
    });
    expect(changed).toBe(1);
    await view.unmount();
  });

  it('an unchanged or blank name sends nothing', async () => {
    const { client, sent } = serving();
    const view = await panel(client);
    await view.click('[data-panel-field="name"]');
    await press(view, '#panel-field-name', 'Enter');
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', '   ');
    await press(view, '#panel-field-name', 'Enter');
    await tick();
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 assignee reads back', () => {
  it('lists the real people and Unassigned, and draws the task’s assignee as chosen', async () => {
    const view = await panel(serving({ assignee: PEOPLE[1] }).client);
    const select = view.find('#panel-field-assignee') as HTMLSelectElement | null;
    expect([...(select?.options ?? [])].map((option) => option.text)).toStrictEqual([
      'Unassigned',
      'Ada',
      'Grace',
    ]);
    expect(select?.value).toBe('p-grace');
    await view.unmount();
  });

  it('with nobody assigned the select reads Unassigned', async () => {
    const view = await panel(serving().client);
    expect((view.find('#panel-field-assignee') as HTMLSelectElement | null)?.value).toBe('');
    await view.unmount();
  });

  it('a person and Unassigned each go through task.assign at the read revision', async () => {
    const { client, sent } = serving({ assignee: PEOPLE[1] });
    const view = await panel(client);
    await view.choose('#panel-field-assignee', 'p-ada');
    await tick();
    await view.choose('#panel-field-assignee', '');
    await tick();
    expect(
      sent.map((each) => [each.to, each.body['fields'], each.body['expectedRevision']]),
    ).toStrictEqual([
      ['/task/assign', { assignee: 'p-ada' }, 4],
      ['/task/assign', { assignee: null }, 4],
    ]);
    await view.unmount();
  });
});

describe('MP-4-8 escape closes only the control', () => {
  it('Escape in the assignee select closes nothing', async () => {
    let closed = 0;
    const view = await panel(serving().client, { close: () => (closed += 1) });
    await press(view, '#panel-field-assignee', 'Escape');
    expect(closed).toBe(0);
    await view.unmount();
  });

  it('Escape in the date picker closes the picker, never the panel', async () => {
    let closed = 0;
    const { client, sent } = serving();
    const view = await panel(client, { close: () => (closed += 1) });
    await view.click('[data-panel-field="due"]');
    await press(view, '[data-date-picker] [role="grid"]', 'Escape');
    expect(view.find('[data-date-picker]')).toBeNull();
    expect(closed).toBe(0);
    await view.click('[data-panel-field="due"]');
    await press(view, '[data-picker="next"]', 'Escape');
    expect(view.find('[data-date-picker]')).toBeNull();
    expect(closed).toBe(0);
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });

  it('Escape in the name edit ends the edit, keeps the name and closes nothing', async () => {
    let closed = 0;
    const { client, sent } = serving();
    const view = await panel(client, { close: () => (closed += 1) });
    await view.click('[data-panel-field="name"]');
    await typeInto(view, '#panel-field-name', 'half typed');
    await press(view, '#panel-field-name', 'Escape');
    expect(view.find('#panel-field-name')).toBeNull();
    expect(view.find('[data-panel-field="name"]')?.textContent).toContain('Budget pacing fix');
    expect(closed).toBe(0);
    expect(sent).toStrictEqual([]);
    await view.unmount();
  });
});

describe('MP-4-8 viewer is the signed-in person', () => {
  it.todo(
    'the panel names the signed-in person where the mockup names a viewer (no session person read on the web yet)',
  );
});
