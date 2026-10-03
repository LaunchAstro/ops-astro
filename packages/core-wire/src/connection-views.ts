// SPDX-License-Identifier: AGPL-3.0-only
//
// What Settings' Keys panel reads (U33): custody's secrets (C31). Types only,
// beside `views.ts`, which holds the rest of the read results; a client takes
// both through the wire package's index.

/**
 * One secret as custody shows it (C31): whether a value is set, its scope and
 * when it was last used, never any part of the value. `clientId` is the party
 * a client-scoped secret belongs to, null for a business-wide one.
 */
export interface SecretView {
  readonly id: string;
  readonly name: string;
  readonly clientId: string | null;
  readonly state: 'set' | 'not set';
  readonly setAt: string | null;
  readonly lastUsedAt: string | null;
  readonly revision: number;
}

export interface SecretListResult {
  readonly ok: true;
  readonly secrets: readonly SecretView[];
  /** The key held business-wide: set and clear are offered only then. */
  readonly canChange: boolean;
}
