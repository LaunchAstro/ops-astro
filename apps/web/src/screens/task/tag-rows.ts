// SPDX-License-Identifier: AGPL-3.0-only
//
// The rows the tag menu offers (MP-4-11, DP-26, DP-27): the vocabulary's tags
// the task does not carry, filtered by what is typed whatever its case, then
// a "new tag" row for typed text the vocabulary does not hold in any case.
// A name the business already has is chosen, never created again; the server
// refuses a duplicate anyway (`UNIQUE_VALUE_TAKEN`).
//
// Suggestions are the tags in use; the categories beside them wait on the
// category presets (MP-5-12, MP-5-13).

import type { TagView } from '../../../../../packages/core-wire/src/index.ts';

export type TagRow =
  { readonly kind: 'tag'; readonly tag: TagView } | { readonly kind: 'new'; readonly name: string };

export function tagRows(
  vocabulary: readonly TagView[],
  carried: readonly TagView[],
  typed: string,
): readonly TagRow[] {
  const name = typed.trim();
  const wanted = name.toLowerCase();
  const onTask = new Set(carried.map((tag) => tag.id));
  const rows: TagRow[] = vocabulary
    .filter((tag) => !onTask.has(tag.id) && tag.name.toLowerCase().includes(wanted))
    .map((tag) => ({ kind: 'tag', tag }));
  const held = vocabulary.some((tag) => tag.name.toLowerCase() === wanted);
  if (name !== '' && !held) rows.push({ kind: 'new', name });
  return rows;
}
