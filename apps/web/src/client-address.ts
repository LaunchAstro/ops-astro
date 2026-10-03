// SPDX-License-Identifier: AGPL-3.0-only
//
// The Clients panel's address at one client (CS-7.29), and reading that client
// back off an address. The route itself is registered in `routes.ts`.

import { pathTo } from './routes.ts';

/** The Clients panel at one client (CS-7.29): the book's address, the client in its query. */
export const clientsAt = (clientId: string): string =>
  `${pathTo('agency:clients')}?client=${encodeURIComponent(clientId)}`;

/** The client an address names in its query, if any. */
export function clientNamedIn(address: string | undefined): string | undefined {
  const query = address?.split('#')[0]?.split('?')[1];
  return query === undefined ? undefined : (new URLSearchParams(query).get('client') ?? undefined);
}
