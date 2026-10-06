// SPDX-License-Identifier: AGPL-3.0-only
//
// What Settings' Keys panel and Connections & signal read (U33): custody's
// secrets (C31) and the connector fleet (MP-14-7a). Types only,
// beside `views.ts`, which holds the rest of the read results; a client takes
// both through the wire package's index. The page's grants, tripwires and
// night round (MP-14-8) are in `signal-views.ts`.

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

/**
 * One connection as the fleet shows it (MP-14-7a). `custody` is a reference:
 * the secret's id and whether custody holds a value for it, never any part of
 * one. `clients` are the ones the caller may read: all of them for a
 * business-wide reader, their own for a client-scoped one. `repairStartedAt`
 * is set when a repair was started on this revision.
 */
export interface ConnectionView {
  readonly id: string;
  readonly connectorKey: string;
  readonly label: string;
  readonly authMethod: string;
  readonly status: 'active' | 'degraded' | 'broken';
  readonly failureClass: string | null;
  readonly cadenceMinutes: number;
  readonly lastSyncedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly scope: string;
  readonly readComponents: readonly string[];
  readonly executeComponents: readonly string[];
  readonly custody: { readonly secretId: string | null; readonly state: 'set' | 'not set' };
  readonly clients: readonly { readonly id: string; readonly label: string }[];
  readonly repairStartedAt: string | null;
  readonly revision: number;
}

/**
 * The fleet: its rows and the counts the facets, tiles and banner draw, which
 * are derived from those same rows so they cannot disagree with them.
 */
export interface ConnectionFleetResult {
  readonly ok: true;
  readonly connections: readonly ConnectionView[];
  readonly counts: {
    readonly all: number;
    readonly active: number;
    readonly degraded: number;
    readonly broken: number;
    readonly clientConnections: number;
  };
}

/** One action class's graduation row for one client (MP-14-10a, section 009). */
export interface GraduationRowView {
  readonly id: string;
  readonly clientId: string;
  readonly actionClass: string;
  readonly classLabel: string;
  readonly clearance: string;
  /** Promoted and held are derived from the live mandates, the rest earned. */
  readonly state: 'promoted' | 'ready' | 'held' | 'short' | 'mixed' | 'never' | 'none';
  readonly heldBy: string | null;
  readonly neverWhy: 'ceiling' | 'audience' | null;
  readonly promotedAt: string | null;
  readonly approved: number;
  readonly edited: number;
  readonly rejected: number;
  readonly since: string | null;
  readonly note: string;
  readonly revision: number;
}

/**
 * A standing mandate or refusal, as filed: the classes and client picked from
 * lists, the ceiling in minor units, the expiry, and the sentence as its label.
 */
export interface MandateView {
  readonly id: string;
  readonly clientId: string;
  readonly classes: readonly string[];
  readonly refuses: boolean;
  readonly ceiling: { readonly amountMinor: number; readonly currency: string } | null;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly label: string;
  readonly graduationClass: string | null;
  readonly authoredBy: string;
  readonly createdAt: string;
  readonly revision: number;
}

/**
 * Connections & signal, the per-client region (MP-14-10a). Every client the
 * caller may see comes back at once, so choosing one on the scope bar is view
 * state and asks the server nothing. A client's label is its own name.
 */
export interface ConnectionGraduationResult {
  readonly ok: true;
  readonly clients: readonly {
    readonly id: string;
    readonly label: string;
    readonly scopes: readonly string[];
  }[];
  readonly rows: readonly GraduationRowView[];
  readonly mandates: readonly MandateView[];
}
