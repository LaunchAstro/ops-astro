// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-9-1, the page kit's sortable table: the supporting checklist line on
// sorting and scrolling, beside the other page kit tests.

import { afterEach, describe, expect, it } from 'vitest';
import { DataTable, nextSort, sortRows, type TableColumn } from '../../packages/ui/src/index.ts';
import { mount, type Mounted } from './mount.tsx';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

interface Row {
  readonly name: string;
  readonly hours: number | null;
}
const columns: readonly TableColumn<Row>[] = [
  { id: 'name', label: 'Name', value: (row) => row.name },
  { id: 'hours', label: 'Hours', value: (row) => row.hours, numeric: true },
];
const rows: readonly Row[] = [
  { name: 'Beta', hours: 2 },
  { name: 'alpha', hours: 10 },
  { name: 'Gamma', hours: null },
  { name: 'Delta', hours: 9.5 },
];

describe('MP-9-1 tables sort on the raw value, numbers first descending, flip on a second click and scroll inside their box', () => {
  it('sorts on the raw number, not its text, descending first, empties last', () => {
    const sorted = sortRows(rows, columns, { column: 'hours', direction: 'desc' });
    expect(sorted.map((row) => row.hours)).toEqual([10, 9.5, 2, null]);
    const flipped = sortRows(rows, columns, { column: 'hours', direction: 'asc' });
    expect(flipped.map((row) => row.hours)).toEqual([2, 9.5, 10, null]);
  });

  it('a first click sorts descending, a second flips, a new column starts descending', () => {
    const first = nextSort(undefined, 'hours');
    expect(first).toEqual({ column: 'hours', direction: 'desc' });
    expect(nextSort(first, 'hours')).toEqual({ column: 'hours', direction: 'asc' });
    expect(nextSort(nextSort(first, 'hours'), 'name')).toEqual({
      column: 'name',
      direction: 'desc',
    });
  });

  it('the mounted table sorts on click, flips on the second and scrolls inside its box', async () => {
    mounted = await mount(
      <DataTable
        label="Hours by person"
        columns={columns}
        rows={rows}
        rowKey={(row) => row.name}
      />,
    );
    expect(mounted.find('.tbl-box')?.getAttribute('tabindex')).toBe('0');
    expect(mounted.find('.tbl-box table')).not.toBeNull();
    await mounted.click('th[data-col="hours"] button');
    const read = (): string[] =>
      mounted?.all('tbody tr td:first-child').map((cell) => cell.textContent ?? '') ?? [];
    expect(read()).toEqual(['alpha', 'Delta', 'Beta', 'Gamma']);
    expect(mounted.find('th[data-col="hours"]')?.getAttribute('aria-sort')).toBe('descending');
    await mounted.click('th[data-col="hours"] button');
    expect(read()).toEqual(['Beta', 'Delta', 'alpha', 'Gamma']);
    expect(mounted.find('th[data-col="hours"]')?.getAttribute('aria-sort')).toBe('ascending');
  });
});
