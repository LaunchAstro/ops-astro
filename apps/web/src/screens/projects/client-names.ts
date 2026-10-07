// SPDX-License-Identifier: AGPL-3.0-only
//
// The client names a Projects board at a client filter offers (C32): the
// clients the reader reaches by `client.list`, each a Client filter even with
// no row, so a Clients row door to a quiet client keeps its filter. A failed
// read keeps the filters the address asks for, never every client's work.

import type { ClientListResult } from '../../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../../data/authorised-read.ts';

export const NO_CLIENTS: readonly string[] = [];

/**
 * The reached clients' names; null while the read is out. A refused or failed
 * read reaches no answer, so the address's own client filters are kept: the
 * board then shows only rows of those clients, never every client's work.
 */
export function clientNamesOf(
  state: ReadState<ClientListResult>,
  query: string,
): readonly string[] | null {
  if (state.outcome === 'loading') return null;
  if (state.outcome === 'denied' || state.outcome === 'unavailable') return requestedIn(query);
  const answered = state.outcome === 'ready' || state.outcome === 'empty' ? state.value : null;
  // An answer without its list offers none, rather than breaking the board.
  return Array.isArray(answered?.clients) && answered.clients.length > 0
    ? answered.clients.map((one) => one.name)
    : NO_CLIENTS;
}

/** The client names an address's filters ask for (`client:"<name>"`, the facet id's escapes undone). */
function requestedIn(query: string): readonly string[] {
  return (new URLSearchParams(query).get('f') ?? '').split(',').flatMap((id) => {
    const name = /^client:"(?<name>.*)"$/u.exec(id)?.groups?.['name'];
    return name === undefined ? [] : [name.replaceAll('%2C', ',').replaceAll('%25', '%')];
  });
}
