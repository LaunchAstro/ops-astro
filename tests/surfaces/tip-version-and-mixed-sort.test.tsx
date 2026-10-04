// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it } from 'vitest';
import { SectionTip, type TipPreferences } from '../../packages/ui/src/page-kit/tips.tsx';
import { sortRows, type TableColumn } from '../../packages/ui/src/page-kit/table.tsx';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

// Sol OW-107.1 correctness, retitled by what it proves; its body is Sol's.
it('a rewritten tip returns after dismissing its previous version in the same mounted view', async () => {
  const saved: { key: string; version: number }[] = [];
  const tip = { page: 'agency:inbox', id: 'intro', version: 1, text: 'Old guidance.' };
  const preferences: TipPreferences = {
    dismissed: {},
    tipsOff: false,
    dismiss: (key, version) => saved.push({ key, version }),
  };
  mounted = await mount(<SectionTip tip={tip} preferences={preferences} />);
  expect(mounted.find('.banner__body')?.textContent).toBe('Old guidance.');
  await mounted.click('button[aria-label="Dismiss this tip"]');
  expect(saved).toEqual([{ key: 'agency:inbox#intro', version: 1 }]);
  expect(mounted.find('.sectip')).toBeNull();
  const savedPreferences = { ...preferences, dismissed: { 'agency:inbox#intro': 1 } };
  await mounted.render(
    <SectionTip
      tip={{ ...tip, version: 2, text: 'Updated guidance.' }}
      preferences={savedPreferences}
    />,
  );
  expect(mounted.find('.banner__body')?.textContent).toBe('Updated guidance.');
});

// Sol OW-107.2 correctness, retitled by what it proves; its body is Sol's.
it('mixed columns keep numbers before text in descending order', () => {
  type Row = { readonly value: string | number | null };
  const columns: readonly TableColumn<Row>[] = [
    { id: 'value', label: 'Value', value: (row) => row.value },
  ];
  const rows: readonly Row[] = [
    { value: 'Beta' },
    { value: 2 },
    { value: null },
    { value: 'Alpha' },
    { value: 10 },
  ];
  expect(
    sortRows(rows, columns, { column: 'value', direction: 'asc' }).map((row) => row.value),
  ).toEqual([2, 10, 'Alpha', 'Beta', null]);
  expect(
    sortRows(rows, columns, { column: 'value', direction: 'desc' }).map((row) => row.value),
  ).toEqual([10, 2, 'Beta', 'Alpha', null]);
});
