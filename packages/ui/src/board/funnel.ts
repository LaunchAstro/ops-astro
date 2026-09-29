// SPDX-License-Identifier: AGPL-3.0-only
// STUB (red): MP-5-7 command bar, not yet written.

import type { Facet, Filters, Preset } from './types.ts';

export const FUNNEL_FIRST = 0;
export type ChipTier = 'words' | 96 | 72 | 56 | 44 | 'icons';
export const CHIP_TIERS: readonly ChipTier[] = [];

export interface RankedFacet {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly count: number;
}

export interface FunnelMenu {
  readonly groups: readonly { readonly kind: string; readonly facets: readonly RankedFacet[] }[];
  readonly shown: number;
  readonly more: number;
}

export function rankFacets<Row>(
  _rows: readonly Row[],
  _facets: readonly Facet<Row>[],
): readonly RankedFacet[] {
  return [];
}

export function funnelMenu(
  _ranked: readonly RankedFacet[],
  _query: string,
  _showAll: boolean,
): FunnelMenu {
  return { groups: [], shown: -1, more: -1 };
}

export function hiddenFilters(_view: Filters, _presets: readonly Preset[]): number {
  return -1;
}

export function fitChipRow(_fits: (tier: ChipTier) => boolean): ChipTier {
  return 'words';
}

export function freshness(
  _changedAt: string | null,
  _now: Date,
): { readonly long: string; readonly short: string } | null {
  return null;
}
