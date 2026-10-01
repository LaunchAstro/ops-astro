// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's estimate (CS-4.14, DP-21): the panel's Estimate select offers the
// mockup's vocabulary, 15m to 2d with a day of eight hours (`estMinutes`), and
// sends whole minutes through `task.update` at the revision the panel read;
// Not set clears it. A stored estimate off the vocabulary is drawn as itself,
// never as another value. The facts band reads it as words. The server side
// (the rule, refusals, audit, isolation) is tests/commands/task-estimate.test.ts.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID, found, page, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const optionsOf = (select: HTMLSelectElement | null) =>
  [...(select?.options ?? [])].map((option) => [option.value, option.text]);

describe('MP-4-8 estimate select', () => {
  it('offers Not set and the vocabulary in minutes, and draws the task’s estimate as chosen', async () => {
    const view = await panel(serving({ estimateMinutes: 480 }).client);
    const select = view.find('#panel-field-estimate') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual([
      ['', 'Not set'],
      ['15', '15m'],
      ['30', '30m'],
      ['60', '1h'],
      ['120', '2h'],
      ['240', '4h'],
      ['480', '1d'],
      ['960', '2d'],
    ]);
    expect(select?.value).toBe('480');
    await view.unmount();
  });

  it('with no estimate the select reads Not set', async () => {
    const view = await panel(serving({ estimateMinutes: null }).client);
    expect((view.find('#panel-field-estimate') as HTMLSelectElement | null)?.value).toBe('');
    await view.unmount();
  });

  it('an estimate off the vocabulary is drawn as itself and kept among the choices', async () => {
    const view = await panel(serving({ estimateMinutes: 90 }).client);
    const select = view.find('#panel-field-estimate') as HTMLSelectElement | null;
    expect(select?.value).toBe('90');
    expect(select?.selectedOptions[0]?.text).toBe('1h 30m');
    await view.unmount();
  });

  it('a choice and Not set each go through task.update at the read revision', async () => {
    const { client, sent } = serving({ estimateMinutes: 480 });
    const view = await panel(client);
    await view.choose('#panel-field-estimate', '120');
    await tick();
    await view.choose('#panel-field-estimate', '');
    await tick();
    expect(sent.map((one) => [one.to, one.body['recordId'], one.body['fields']])).toStrictEqual([
      ['/task/update', TASK_ID, { estimated_minutes: 120 }],
      ['/task/update', TASK_ID, { estimated_minutes: null }],
    ]);
    expect(sent[0]?.body['expectedRevision']).toBe(4);
    await view.unmount();
  });
});

describe('MP-4-8 the facts band reads the estimate', () => {
  it('as the vocabulary word, as hours and minutes off it, and "not set" without one', async () => {
    const words: string[] = [];
    for (const estimateMinutes of [960, 45, 150, null]) {
      // eslint-disable-next-line no-await-in-loop -- one mount at a time
      const view = await page('Proj-Verity-Pacing', found({ estimateMinutes }));
      words.push(view.find('[data-field="estimate"] dd')?.textContent?.trim() ?? '');
      // eslint-disable-next-line no-await-in-loop
      await view.unmount();
    }
    expect(words).toStrictEqual(['2d', '45m', '2h 30m', 'not set']);
  });
});
