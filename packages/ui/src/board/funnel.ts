// SPDX-License-Identifier: AGPL-3.0-only
//
// The command bar's pure parts (MP-5-7, B-04, B-05, B-25, P-07, CS-5.3).
//
// The funnel lists every filter the board offers, ranked by how many of the
// handed rows each holds, so a count never includes a row the viewer may not
// read. "Find a filter…" narrows those controls at word starts (R46) and
// never touches the rows. Five show, then Show all. The badge counts the
// filters on that no chip on the bar shows. The chip row fits by a ladder of
// ever shorter labels, and the freshness stamp says how long ago the newest
// record in scope changed. It is a stamp, not a control: the board stays
// live (C4), so there is nothing to sync.

import { startsAWord } from './filters.ts';
import type { Facet, Filters, Preset } from './types.ts';

/** How many filters the menu shows before Show all. */
export const FUNNEL_FIRST = 5;

/** The chip row's ladder: full words, capped widths in pixels, then icons. */
export type ChipTier = 'words' | 96 | 72 | 56 | 44 | 'icons';
export const CHIP_TIERS: readonly ChipTier[] = ['words', 96, 72, 56, 44, 'icons'];

export interface RankedFacet {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly count: number;
}

export interface FunnelMenu {
  /** Kinds in the order of their best-ranked filter; filters in rank order. */
  readonly groups: readonly { readonly kind: string; readonly facets: readonly RankedFacet[] }[];
  /** How many filters the groups hold. */
  readonly shown: number;
  /** How many matching filters Show all would add. */
  readonly more: number;
}

/** Every facet with the number of `rows` it holds, most first, ties as declared. */
export function rankFacets<Row>(
  rows: readonly Row[],
  facets: readonly Facet<Row>[],
): readonly RankedFacet[] {
  return facets
    .map((facet, order) => ({
      order,
      ranked: {
        id: facet.id,
        kind: facet.kind,
        label: facet.label,
        count: rows.filter((row) => facet.test(row)).length,
      },
    }))
    .toSorted((a, b) => b.ranked.count - a.ranked.count || a.order - b.order)
    .map((one) => one.ranked);
}

/** The menu for a query: narrowed at word starts, five or all, grouped by kind. */
export function funnelMenu(
  ranked: readonly RankedFacet[],
  query: string,
  showAll: boolean,
): FunnelMenu {
  const q = query.trim();
  const matched = q === '' ? ranked : ranked.filter((one) => startsAWord(one.label, q));
  const shown = showAll ? matched : matched.slice(0, FUNNEL_FIRST);
  const groups = new Map<string, RankedFacet[]>();
  for (const one of shown) {
    const group = groups.get(one.kind);
    if (group === undefined) groups.set(one.kind, [one]);
    else group.push(one);
  }
  return {
    groups: [...groups].map(([kind, facets]) => ({ kind, facets })),
    shown: shown.length,
    more: matched.length - shown.length,
  };
}

/**
 * The filters on that no chip on the bar shows: every facet an on preset
 * does not account for, and every typed word.
 */
export function hiddenFilters(view: Filters, presets: readonly Preset[]): number {
  const shown = new Set(
    presets
      .filter(
        (preset) =>
          preset.facetIds.length > 0 && preset.facetIds.every((id) => view.ids.includes(id)),
      )
      .flatMap((preset) => preset.facetIds),
  );
  return view.ids.filter((id) => !shown.has(id)).length + view.text.length;
}

/** The first tier whose chips fit one row; icons when none does. */
export function fitChipRow(fits: (tier: ChipTier) => boolean): ChipTier {
  for (const tier of CHIP_TIERS) {
    if (tier === 'icons') return tier;
    if (fits(tier)) return tier;
  }
  return 'icons';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `changedAt` was, in words; null when there is no such time. */
export function freshness(
  changedAt: string | null,
  now: Date,
): { readonly long: string; readonly short: string } | null {
  if (changedAt === null) return null;
  const then = Date.parse(changedAt);
  if (Number.isNaN(then)) return null;
  const ago = now.getTime() - then;
  if (ago < MINUTE) return { long: 'Updated just now', short: 'just now' };
  const [n, unit, letter] =
    ago < HOUR
      ? [Math.floor(ago / MINUTE), 'minute', 'm']
      : ago < DAY
        ? [Math.floor(ago / HOUR), 'hour', 'h']
        : [Math.floor(ago / DAY), 'day', 'd'];
  return {
    long: `Updated ${String(n)} ${unit}${n === 1 ? '' : 's'} ago`,
    short: `${String(n)}${letter} ago`,
  };
}
