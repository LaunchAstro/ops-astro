// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-4-8's Category select (CS-4.16, DP-23; BUILDABLE-NOW (b)4): the dock
// panel's field grid offers Not set and the nine catalogue categories
// (`TASK_CATEGORIES`), keeps a stored value off the list as itself, and sends
// the chosen id, or null for Not set, through `task.set_category` at the
// revision read. The task page's facts band reads the same label. The server
// side (refusals, audit, crossings, agent scope) is task-set-category's suites.

import { afterEach, describe, expect, it } from 'vitest';
import { TASK_CATEGORIES } from '../../packages/core-wire/src/index.ts';
import { TASK_ID, found, page, tick } from './task-page-stub.tsx';
import { unmountAll } from './perspective-support.tsx';
import { panel, serving } from './panel-fields-support.tsx';

afterEach(unmountAll);

const optionsOf = (select: HTMLSelectElement | null) =>
  [...(select?.options ?? [])].map((option) => [option.value, option.text]);

const NINE = TASK_CATEGORIES.list().map((one) => [one.id, one.label]);

const commands = (sent: ReturnType<typeof serving>['sent']) =>
  sent.map((one) => {
    const { operationId: _unread, ...body } = one.body;
    return [one.to, body];
  });

describe('MP-4-8 Category select on the dock panel', () => {
  it('offers Not set, then the nine categories in the list’s order, with none chosen', async () => {
    const view = await panel(serving().client);
    const select = view.find('#panel-field-category') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual([['', 'Not set'], ...NINE]);
    expect(select?.value).toBe('');
    await view.unmount();
  });

  it('shows the stored category chosen', async () => {
    const view = await panel(serving({ category: 'paid-ads' }).client);
    const select = view.find('#panel-field-category') as HTMLSelectElement | null;
    expect(select?.value).toBe('paid-ads');
    await view.unmount();
  });

  it('a choice goes through task.set_category with its id at the read revision', async () => {
    const { client, sent } = serving();
    let changed = 0;
    const view = await panel(client, { changed: () => (changed += 1) });
    await view.choose('#panel-field-category', 'dev-integrations');
    await tick();
    expect(commands(sent)).toStrictEqual([
      [
        '/task/set_category',
        { recordId: TASK_ID, expectedRevision: 4, fields: { category: 'dev-integrations' } },
      ],
    ]);
    expect(changed).toBe(1);
    await view.unmount();
  });
});

describe('MP-4-8 Category select on the dock panel: clearing and off the list', () => {
  it('Not set clears it: task.set_category with null', async () => {
    const { client, sent } = serving({ category: 'seo' });
    const view = await panel(client);
    await view.choose('#panel-field-category', '');
    await tick();
    expect(commands(sent)).toStrictEqual([
      [
        '/task/set_category',
        { recordId: TASK_ID, expectedRevision: 4, fields: { category: null } },
      ],
    ]);
    await view.unmount();
  });

  it('a stored value off the list is kept as itself, last, and chosen', async () => {
    const view = await panel(serving({ category: 'Legacy work' }).client);
    const select = view.find('#panel-field-category') as HTMLSelectElement | null;
    expect(optionsOf(select)).toStrictEqual([
      ['', 'Not set'],
      ...NINE,
      ['Legacy work', 'Legacy work'],
    ]);
    expect(select?.value).toBe('Legacy work');
    await view.unmount();
  });
});

describe('MP-4-8 Category on the task page facts', () => {
  it('the facts band names the stored category by its label', async () => {
    const view = await page('Proj-Verity-Pacing', found({ category: 'website-edits' }));
    expect(view.find('[data-field="category"] dd')?.textContent).toBe('Website Edits');
    await view.unmount();
  });
});
