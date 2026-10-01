// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Stage select (CS-4.17, DP-24): the panel offers Not set and the
// task stage list (`TASK_STAGES`, the six journey stages in order, then Ops),
// the same list the Projects board's Stage column reads, and sends the stage's
// id through `task.set_stage` at the revision the panel read. A stored stage
// outside the list stays among the choices as itself. The facts band reads the
// stage by its label. The server side (the owning operation, refusals, audit)
// is task.set_stage's own suites.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, found, page, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const optionsOf = (select: HTMLSelectElement | null) =>
  [...(select?.options ?? [])].map((option) => [option.value, option.text]);

describe('MP-4-8 Stage select', () => {
  it('offers Not set and the stage list in journey order, Ops last, with the task’s stage chosen', async () => {
    const view = await panel(serving({ stage: 'trust' }).client);
    const select = view.find('#panel-field-stage') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual([
      ['', 'Not set'],
      ['awareness', 'Awareness'],
      ['trust', 'Trust'],
      ['enquiries', 'Enquiries'],
      ['sales', 'Sales'],
      ['retention', 'Retention'],
      ['advocacy', 'Advocacy'],
      ['ops', 'Ops'],
    ]);
    expect(select?.value).toBe('trust');
    await view.unmount();
  });

  it('a stored stage outside the list stays among the choices as itself', async () => {
    const view = await panel(serving({ stage: 'Discovery' }).client);
    const select = view.find('#panel-field-stage') as HTMLSelectElement | null;
    expect(optionsOf(select).at(-1)).toStrictEqual(['Discovery', 'Discovery']);
    expect(select?.value).toBe('Discovery');
    await view.unmount();
  });

  it('a stage and Not set each go through task.set_stage at the read revision', async () => {
    const { client, sent } = serving({ stage: null });
    const view = await panel(client);
    await view.choose('#panel-field-stage', 'sales');
    await tick();
    await view.choose('#panel-field-stage', '');
    await tick();
    expect(sent.map((one) => [one.to, one.body['recordId'], one.body['fields']])).toStrictEqual([
      ['/task/set_stage', TASK_ID, { stage: 'sales' }],
      ['/task/set_stage', TASK_ID, { stage: null }],
    ]);
    expect(sent.map((one) => one.body['expectedRevision'])).toStrictEqual([4, 4]);
    await view.unmount();
  });
});

describe('MP-4-8 the facts band reads the stage', () => {
  it('by its label, a value off the list as stored, and "not set" without one', async () => {
    const words: string[] = [];
    for (const stage of ['enquiries', 'Discovery', null]) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const view = await page('Proj-Verity-Pacing', found({ stage }));
      words.push(view.find('[data-field="stage"] dd')?.textContent?.trim() ?? '');
      // eslint-disable-next-line no-await-in-loop
      await view.unmount();
    }
    expect(words).toStrictEqual(['Enquiries', 'Discovery', 'not set']);
  });
});
