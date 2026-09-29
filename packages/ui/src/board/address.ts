// SPDX-License-Identifier: AGPL-3.0-only
//
// The view in the address (B-01, B-06, C6): the facets, the free words, the
// sort and the mode, so a reload keeps the view and a copied address opens
// the same view for another person. It carries no rows: the person who opens
// it sees only the rows their own grants allow. Column widths are a per-person
// preference (MP-5-6) and stay out of it.
//
// What the board does not offer is dropped on the way in: an unknown facet,
// column or mode, a malformed sort, a word that did not decode. The address is
// something anyone can type, so nothing in it is trusted.

import type { BoardContext, BoardView, SortState } from './types.ts';

const MAX_WORDS = 20;
const MAX_WORD_LENGTH = 64;
// A replacement character means the address did not decode; control
// characters are never typed.
const UNREADABLE = /[�\p{Cc}]/u;

export function writeView(view: BoardView): string {
  const params = new URLSearchParams();
  if (view.ids.length > 0) params.set('f', view.ids.join(','));
  if (view.text.length > 0) params.set('q', view.text.join(' '));
  if (view.sort !== null) params.set('sort', `${view.sort.key}.${view.sort.dir}`);
  if (view.mode !== null) params.set('mode', view.mode);
  return params.toString();
}

export function readView<Row>(search: string, context: BoardContext<Row>): BoardView {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const facetIds = new Set(context.facets.map((facet) => facet.id));
  const ids = [...new Set((params.get('f') ?? '').split(','))].filter((id) => facetIds.has(id));
  const text = [...new Set((params.get('q') ?? '').split(/\s+/u))]
    .filter((word) => word !== '' && word.length <= MAX_WORD_LENGTH && !UNREADABLE.test(word))
    .map((word) => word.toLowerCase())
    .slice(0, MAX_WORDS);
  const modeId = params.get('mode');
  const mode = context.modes.some((one) => one.id === modeId) ? modeId : null;
  return { ids, text, sort: sortOf(params.get('sort'), context), mode, widths: null };
}

function sortOf<Row>(raw: string | null, context: BoardContext<Row>): SortState | null {
  const match = /^(?<key>[\w-]+)\.(?<dir>asc|desc)$/u.exec(raw ?? '');
  const key = match?.groups?.['key'];
  const dir = match?.groups?.['dir'];
  if (key === undefined || (dir !== 'asc' && dir !== 'desc')) return null;
  const column = context.columns.find((one) => one.key === key);
  return column?.sortValue === undefined ? null : { key, dir };
}
