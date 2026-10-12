// SPDX-License-Identifier: AGPL-3.0-only
//
// The Work log search's own state (MP-8-4): the words typed, held in the
// address so a reload or a shared link opens it searched, and the people the
// reader has seen act, which the search reads names against. In a dock panel
// the words are the panel's own: read from its address, written to no page
// address. The people belong to the reader they were read for.

import { useState } from 'react';
import type { LedgerDayView } from '../../../../../packages/core-wire/src/index.ts';
import { actorsIn } from './ledger-search.ts';

/** The search's words in the address (L-01 `q`). */
const typedInAddress = (address: string | undefined): string =>
  (address === undefined
    ? new URLSearchParams(globalThis.location?.search ?? '')
    : new URL(address, 'http://here').searchParams
  ).get('q') ?? '';

function writeTyped(typed: string): void {
  const here = globalThis.location;
  if (here === undefined) return;
  const query = new URLSearchParams(here.search);
  if (typed === '') query.delete('q');
  else query.set('q', typed);
  const search = query.size === 0 ? '' : `?${query.toString()}`;
  globalThis.history.replaceState(
    globalThis.history.state,
    '',
    `${here.pathname}${search}${here.hash}`,
  );
}

/** The words typed, from and to the page's address, or only from a panel's own. */
export function useTyped(
  address: string | undefined,
  inPanel: boolean,
): readonly [string, (words: string) => void] {
  const [typed, setWords] = useState(() => typedInAddress(inPanel ? (address ?? '') : undefined));
  const setTyped = (words: string): void => {
    setWords(words);
    if (!inPanel) writeTyped(words);
  };
  return [typed, setTyped];
}

/**
 * The names of everyone the reader `grantKey` has seen act, and `see`, which
 * adds those acting in days read for that reader. Called while rendering.
 */
export function usePeopleSeen(grantKey: string) {
  const [seen, setSeen] = useState({ grantKey, names: [] as readonly string[] });
  const names = seen.grantKey === grantKey ? seen.names : [];
  const see = (days: readonly LedgerDayView[]): void => {
    const known = [...new Set([...names, ...actorsIn(days)])];
    if (known.length !== names.length) setSeen({ grantKey, names: known });
  };
  return { names, see };
}
