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

import { boundedWords } from './filters.ts';
import type { BoardContext, BoardView, SortState } from './types.ts';

// Control characters are never typed, and `decoded` marks an escape that is
// not UTF-8 with one, so its word is dropped.
const UNREADABLE = /\p{Cc}/u;
const NOT_UTF8 = '\u0000';
const FATAL = new TextDecoder('utf-8', { fatal: true });
const LENIENT = new TextDecoder('utf-8');

/**
 * A query component decoded as URLSearchParams decodes it, except that bytes
 * which are not UTF-8 read as NOT_UTF8 rather than U+FFFD. A replacement
 * character the board wrote itself (`%EF%BF%BD`) decodes and is kept.
 */
function decoded(raw: string): string {
  return raw.replaceAll('+', ' ').replaceAll(/(?:%[\dA-Fa-f]{2})+/gu, (run) => {
    const bytes = Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16));
    try {
      return FATAL.decode(bytes);
    } catch {
      return LENIENT.decode(bytes).replaceAll('\uFFFD', NOT_UTF8);
    }
  });
}

/** The first `name` value in `search`, decoded by `decoded`; null when absent. */
function queryParam(search: string, name: string): string | null {
  for (const pair of search.split('&')) {
    const at = pair.indexOf('=');
    if (decoded(at === -1 ? pair : pair.slice(0, at)) === name)
      return at === -1 ? '' : decoded(pair.slice(at + 1));
  }
  return null;
}

/**
 * The address for a view. `f` is always written, empty when no filter is on,
 * so a reload after Clear all or a mode that dropped the viewer's filter keeps
 * none on: only an address with no `f` at all opens on the viewer preset
 * (REVIEW-2C1-5, `openWithViewer`).
 */
export function writeView(view: BoardView): string {
  const params = new URLSearchParams();
  params.set('f', view.ids.join(','));
  if (view.text.length > 0) params.set('q', view.text.join(' '));
  if (view.sort !== null) params.set('sort', `${view.sort.key}.${view.sort.dir}`);
  if (view.mode !== null) params.set('mode', view.mode);
  return params.toString();
}

export function readView<Row>(search: string, context: BoardContext<Row>): BoardView {
  const query = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  const facetIds = new Set(context.facets.map((facet) => facet.id));
  const ids = [...new Set((params.get('f') ?? '').split(','))].filter((id) => facetIds.has(id));
  const text = boundedWords(
    [...new Set((queryParam(query, 'q') ?? '').split(/\s+/u))]
      .filter((word) => word !== '' && !UNREADABLE.test(word))
      .map((word) => word.toLowerCase()),
  );
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
