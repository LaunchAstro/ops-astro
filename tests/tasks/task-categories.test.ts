// SPDX-License-Identifier: AGPL-3.0-only
//
// The task category list (CS-4.16, DP-23): the nine presets of the Projects
// board's category chips (P-13), a work label only (R76). A task stores the
// category's id through `task.set_category`; every surface reads the label
// from here, and a stored value outside the list is shown as it is stored.

import { describe, expect, it } from 'vitest';
import { TASK_CATEGORIES } from '../../packages/core-wire/src/index.ts';

describe('the task category list', () => {
  it('lists the nine presets in the register’s order, each id its label’s words', () => {
    expect(TASK_CATEGORIES.list().map((one) => [one.id, one.label])).toStrictEqual([
      ['admin', 'Admin'],
      ['branding', 'Branding'],
      ['content', 'Content'],
      ['dev-integrations', 'Dev & Integrations'],
      ['paid-ads', 'Paid Ads'],
      ['reporting', 'Reporting'],
      ['seo', 'SEO'],
      ['videography', 'Videography'],
      ['website-edits', 'Website Edits'],
    ]);
  });

  it('knows an id, and nothing else: a label, a case change, a blank or a non-string', () => {
    expect(TASK_CATEGORIES.list().every((one) => TASK_CATEGORIES.has(one.id))).toBe(true);
    expect(
      ['SEO', 'Seo', ' seo', '', 'agent-scope', null, undefined, 7, { id: 'seo' }, ['seo']].map(
        (value) => TASK_CATEGORIES.has(value),
      ),
    ).toStrictEqual([false, false, false, false, false, false, false, false, false, false]);
  });

  it('names a stored category by its label, and a value outside the list as it is stored', () => {
    expect([
      TASK_CATEGORIES.labelOf('paid-ads'),
      TASK_CATEGORIES.labelOf('dev-integrations'),
      TASK_CATEGORIES.labelOf('Legacy work'),
    ]).toStrictEqual(['Paid Ads', 'Dev & Integrations', 'Legacy work']);
  });
});
