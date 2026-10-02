// SPDX-License-Identifier: AGPL-3.0-only
//
// Facets, presets, the query parser and the reading line (MP-5-3, MP-5-5).
//
// One narrowing rule: facets of the same kind OR together, different kinds
// AND, and every free word must appear in the row at the start of a word
// (R46: `ad` finds Admin and Advocacy, never `head`). The gesture law: a plain
// press replaces the filters (or clears them when it was the only one on),
// shift adds or removes within them (B-06).
//
// The rows handed in are the rows the viewer may read, and nothing here reads
// any others: counts, presets and suggestions are all computed over them.

import type { Facet, Filters, Preset } from './types.ts';

const WORD = /[\p{L}\p{N}]/u;

/** Whether `term` appears in `text` starting at a word's first character. */
export function startsAWord(text: string, term: string): boolean {
  const hay = text.toLowerCase();
  const needle = term.toLowerCase();
  if (needle === '') return false;
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    if (at === 0 || !WORD.test(hay.charAt(at - 1))) return true;
  }
  return false;
}

/** A press on a facet: plain replaces (or clears the only one), shift toggles. */
export function pressFacet(ids: readonly string[], id: string, stack: boolean): readonly string[] {
  if (stack) return ids.includes(id) ? ids.filter((one) => one !== id) : [...ids, id];
  return ids.length === 1 && ids[0] === id ? [] : [id];
}

export function narrowRows<Row>(
  rows: readonly Row[],
  filters: Filters,
  facets: readonly Facet<Row>[],
  hay: (row: Row) => string,
): readonly Row[] {
  const byKind = new Map<string, Facet<Row>[]>();
  for (const id of filters.ids) {
    const facet = facets.find((one) => one.id === id);
    if (facet === undefined) continue;
    byKind.set(facet.kind, [...(byKind.get(facet.kind) ?? []), facet]);
  }
  const kinds = [...byKind.values()];
  return rows.filter(
    (row) =>
      kinds.every((same) => same.some((facet) => facet.test(row))) &&
      filters.text.every((term) => startsAWord(hay(row), term)),
  );
}

/** Split a typed query: a token naming a facet is that facet, the rest are free words. */
export function parseQuery<Row>(raw: string, facets: readonly Facet<Row>[]): Filters {
  const ids: string[] = [];
  const text: string[] = [];
  for (const token of raw.trim().split(/\s+/u)) {
    const word = token.toLowerCase();
    if (word === '') continue;
    const facet = facets.find(
      (one) => one.label.toLowerCase() === word || (one.words ?? []).includes(word),
    );
    if (facet !== undefined) {
      if (!ids.includes(facet.id)) ids.push(facet.id);
    } else if (!text.includes(word)) {
      text.push(word);
    }
  }
  return { ids, text };
}

/** How many of these rows the preset would show; counts come from the rows. */
export function presetCount<Row>(
  rows: readonly Row[],
  preset: Preset,
  facets: readonly Facet<Row>[],
  hay: (row: Row) => string,
): number {
  return narrowRows(rows, { ids: preset.facetIds, text: [] }, facets, hay).length;
}

/**
 * The reading line (B-22): what the filters mean in words and how many rows
 * pass, then how many rows the viewer's grants withheld, never which. Empty
 * when nothing is on and nothing is withheld.
 */
export function readingLine<Row>(
  filters: Filters,
  facets: readonly Facet<Row>[],
  shown: number,
  withheld: number,
): string {
  const byKind = new Map<string, string[]>();
  for (const id of filters.ids) {
    const facet = facets.find((one) => one.id === id);
    if (facet !== undefined)
      byKind.set(facet.kind, [...(byKind.get(facet.kind) ?? []), facet.label]);
  }
  const bits = [...byKind.values()].map((labels) => labels.join(' or '));
  if (filters.text.length > 0) {
    bits.push(`the words ${filters.text.map((term) => `“${term}”`).join(' + ')}`);
  }
  const hidden = withheld > 0 ? ` · ${String(withheld)} more withheld by permission` : '';
  if (bits.length > 0)
    return `Reading this as ${bits.join(' · ')} — ${String(shown)} of them${hidden}`;
  return withheld > 0 ? `${String(shown)} shown${hidden}` : '';
}
