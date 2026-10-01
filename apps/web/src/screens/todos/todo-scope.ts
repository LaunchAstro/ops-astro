// SPDX-License-Identifier: AGPL-3.0-only
//
// Whose to-dos the Projects panel lists (MP-7-2, CS-7.4): the reader's own,
// a teammate's, a client's, a client's waiting comments, or a client's route
// family. Stub: the scope's types and the made-up clients only.

import type { Provenance } from '@launchastro/ui';

export type TodoScope =
  | { readonly kind: 'mine' }
  | { readonly kind: 'person'; readonly personId: string; readonly name: string }
  | {
      readonly kind: 'client';
      readonly clientId: string;
      readonly name: string;
      readonly waiting?: boolean;
      readonly family?: string;
    };

/** One client the scope offers: its id (the task's `client`), its name and its route families. */
export interface ClientChoice {
  readonly id: string;
  readonly name: string;
  readonly families: readonly string[];
}

/** Where the clients come from, and whether they are real. */
export interface ClientSource {
  readonly provenance: Provenance;
  readonly clients: readonly ClientChoice[];
}

// TODO(MP-7-2, family B C32): the business's client list replaces these.
export const MOCK_CLIENTS: ClientSource = {
  provenance: 'mock',
  clients: [
    {
      id: '0b7d3c1e-5f2a-4c8e-9a61-3d2f7e4b9c01',
      name: 'Harbour Physio',
      families: ['Agent', 'Review', 'Team'],
    },
    {
      id: '6e2a9f40-1c7b-4d35-8e92-a4b0c5d6e702',
      name: 'Northside Dental',
      families: ['Agent', 'Review', 'Team'],
    },
  ],
};
