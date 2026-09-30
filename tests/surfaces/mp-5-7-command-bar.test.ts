// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-5-7 (U13), the parts of the command bar that are pure: every filter
// ranked by the rows it holds, "Find a filter…" narrowing the controls, Show
// all and Show fewer, the funnel's badge, the chip row's fit ladder and the
// freshness words. What needs a document is in `mp-5-6-7-board-dom.test.tsx`;
// what needs the database in `tests/reads/mp-5-board-isolation.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  CHIP_TIERS,
  FUNNEL_FIRST,
  fitChipRow,
  freshness,
  funnelMenu,
  hiddenFilters,
  rankFacets,
  type ChipTier,
  type Facet,
  type Preset,
} from '../../packages/ui/src/board/index.ts';

interface Row {
  readonly id: string;
  readonly client: string;
  readonly status: string;
  readonly stage: string;
}

const ROWS: readonly Row[] = [
  { id: 'r1', client: 'Acme Advocacy', status: 'Active', stage: 'Awareness' },
  { id: 'r2', client: 'Acme Advocacy', status: 'Active', stage: 'Enquiries' },
  { id: 'r3', client: 'Beta Bakery', status: 'Active', stage: 'Awareness' },
  { id: 'r4', client: 'Beta Bakery', status: 'Paused', stage: 'Awareness' },
  { id: 'r5', client: 'Cedar Clinic', status: 'Active', stage: 'Retention' },
];

const facet = (kind: string, label: string, test: (row: Row) => boolean): Facet<Row> => ({
  id: `${kind.toLowerCase()}:${label.toLowerCase().replaceAll(' ', '-')}`,
  kind,
  label,
  test,
});

// Declared in an order unlike their counts, so ranking is visible.
const FACETS: readonly Facet<Row>[] = [
  facet('Client', 'Cedar Clinic', (row) => row.client === 'Cedar Clinic'),
  facet('Client', 'Acme Advocacy', (row) => row.client === 'Acme Advocacy'),
  facet('Client', 'Beta Bakery', (row) => row.client === 'Beta Bakery'),
  facet('Status', 'Paused', (row) => row.status === 'Paused'),
  facet('Status', 'Active', (row) => row.status === 'Active'),
  facet('Stage', 'Retention', (row) => row.stage === 'Retention'),
  facet('Stage', 'Awareness', (row) => row.stage === 'Awareness'),
  facet('Stage', 'Enquiries', (row) => row.stage === 'Enquiries'),
  facet('Stage', 'Won back', (row) => row.stage === 'Won back'),
];

const PRESETS: readonly Preset[] = [
  { id: 'live', label: 'Live work', facetIds: ['status:active'] },
  { id: 'acme-new', label: 'Acme, new', facetIds: ['client:acme-advocacy', 'stage:enquiries'] },
];

describe('MP-5-7 every filter, ranked by row count (CS-5.3)', () => {
  it('lists every filter the board offers, most rows first, ties in the declared order', () => {
    const ranked = rankFacets(ROWS, FACETS);
    expect(ranked.map((one) => `${one.label} ${String(one.count)}`)).toEqual([
      'Active 4',
      'Awareness 3',
      'Acme Advocacy 2',
      'Beta Bakery 2',
      'Cedar Clinic 1',
      'Paused 1',
      'Retention 1',
      'Enquiries 1',
      'Won back 0',
    ]);
  });

  it('counts only the rows it is handed', () => {
    const inScope = ROWS.filter((row) => row.client === 'Acme Advocacy');
    const ranked = rankFacets(inScope, FACETS);
    const count = (label: string): number | undefined =>
      ranked.find((one) => one.label === label)?.count;
    expect(count('Beta Bakery')).toBe(0);
    expect(count('Cedar Clinic')).toBe(0);
    expect(count('Awareness')).toBe(1);
    expect(ranked).toHaveLength(FACETS.length);
  });

  it('groups by kind, the kind whose best filter ranks highest first; five, then Show all', () => {
    const menu = funnelMenu(rankFacets(ROWS, FACETS), '', false);
    expect(FUNNEL_FIRST).toBe(5);
    expect(menu.groups.map((group) => group.kind)).toEqual(['Status', 'Stage', 'Client']);
    expect(menu.groups.flatMap((group) => group.facets.map((one) => one.label))).toEqual([
      'Active',
      'Awareness',
      'Acme Advocacy',
      'Beta Bakery',
      'Cedar Clinic',
    ]);
    expect(menu.more).toBe(4);
    const all = funnelMenu(rankFacets(ROWS, FACETS), '', true);
    expect(all.groups.flatMap((group) => group.facets)).toHaveLength(9);
    expect(all.more).toBe(0);
    expect(all.shown).toBe(9);
  });
});

describe('MP-5-7 find a filter', () => {
  const ranked = rankFacets(ROWS, FACETS);
  const labels = (query: string, showAll = false): readonly string[] =>
    funnelMenu(ranked, query, showAll).groups.flatMap((group) =>
      group.facets.map((one) => one.label),
    );

  it('narrows the controls at word starts, whatever the case, and keeps their rank', () => {
    expect(labels('a')).toEqual(['Active', 'Awareness', 'Acme Advocacy']);
    expect(labels('ADV')).toEqual(['Acme Advocacy']);
    expect(labels('  back ')).toEqual(['Won back']);
    expect(labels('ctive')).toEqual([]);
  });

  it('five then Show all over the narrowed list, and a query matching nothing says so', () => {
    const wide = funnelMenu(ranked, 'e', false);
    expect(wide.shown).toBe(1);
    expect(wide.more).toBe(0);
    const none = funnelMenu(ranked, 'zzz', false);
    expect(none.shown).toBe(0);
    expect(none.groups).toEqual([]);
  });
});

describe('MP-5-7 funnel badge', () => {
  it('counts the filters on that no chip on the bar shows', () => {
    expect(hiddenFilters({ ids: [], text: [] }, PRESETS)).toBe(0);
    // Live work is on, so Active is shown by its chip.
    expect(hiddenFilters({ ids: ['status:active'], text: [] }, PRESETS)).toBe(0);
    // A stage from the menu and a typed word have no chip of their own.
    expect(
      hiddenFilters({ ids: ['status:active', 'stage:awareness'], text: ['logo'] }, PRESETS),
    ).toBe(2);
    // Half a preset is not the preset: both its filters are counted.
    expect(hiddenFilters({ ids: ['client:acme-advocacy'], text: [] }, PRESETS)).toBe(1);
    expect(
      hiddenFilters({ ids: ['client:acme-advocacy', 'stage:enquiries'], text: [] }, PRESETS),
    ).toBe(0);
  });
});

describe('MP-5-7 chip ladder', () => {
  it('tries words, then 96, 72, 56 and 44 caps, then icons, and stops at the first that fits', () => {
    expect(CHIP_TIERS).toEqual(['words', 96, 72, 56, 44, 'icons']);
    const tried: ChipTier[] = [];
    const tier = fitChipRow((one) => {
      tried.push(one);
      return one === 56;
    });
    expect(tier).toBe(56);
    expect(tried).toEqual(['words', 96, 72, 56]);
    expect(fitChipRow(() => true)).toBe('words');
  });

  it('icons are the last resort, taken without measuring', () => {
    const tried: ChipTier[] = [];
    expect(
      fitChipRow((one) => {
        tried.push(one);
        return false;
      }),
    ).toBe('icons');
    expect(tried).toEqual(['words', 96, 72, 56, 44]);
  });
});

describe('MP-5-7 freshness words', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const at = (iso: string | null): readonly [string, string] | null => {
    const words = freshness(iso, now);
    return words === null ? null : [words.long, words.short];
  };

  it('says how long ago the newest record in scope changed, long and short', () => {
    expect(at('2026-09-29T11:59:30Z')).toEqual(['Updated just now', 'just now']);
    expect(at('2026-09-29T11:59:00Z')).toEqual(['Updated 1 minute ago', '1m ago']);
    expect(at('2026-09-29T11:15:00Z')).toEqual(['Updated 45 minutes ago', '45m ago']);
    expect(at('2026-09-29T10:00:00Z')).toEqual(['Updated 2 hours ago', '2h ago']);
    expect(at('2026-09-28T11:00:00Z')).toEqual(['Updated 1 day ago', '1d ago']);
    expect(at('2026-09-19T12:00:00Z')).toEqual(['Updated 10 days ago', '10d ago']);
  });

  it('a clock ahead of ours is just now; nothing in scope, or no date, is no stamp', () => {
    expect(at('2026-09-29T12:05:00Z')).toEqual(['Updated just now', 'just now']);
    expect(at(null)).toBeNull();
    expect(at('not a date')).toBeNull();
  });
});
