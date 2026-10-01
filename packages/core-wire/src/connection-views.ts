// SPDX-License-Identifier: AGPL-3.0-only
//
// What the Connections & signal page and Settings' Keys and Workflow triggers
// panels read (U33, U36, U39): custody's secrets (C31), the connector fleet
// (MP-14-7a), signal and grants (MP-14-8), graduation and standing mandates
// (MP-14-10a), and the automation registry (C33, C52-A). Types only, beside
// `views.ts`, which holds the rest of the read results; a client takes both
// through the wire package's index.

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

/**
 * One grant (MP-14-8): a delegation, a named agent's time-boxed claim for one
 * job. `access` is `exec` when any of its actions is more than a read.
 * `redemptions` counts the applied calls made under it; nothing records what
 * each reached. `client` is null for a fleet grant.
 */
export interface GrantView {
  readonly id: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly collections: readonly string[];
  readonly access: 'read' | 'exec';
  readonly client: { readonly id: string; readonly label: string | null } | null;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly endedAt: string | null;
  readonly revocationCause: string | null;
  readonly state: 'live' | 'ran_out' | 'taken_back';
  readonly redemptions: number;
}

/** One tripwire (MP-14-8). An unarmable one carries no firing history. */
export interface TripwireView {
  readonly id: string;
  readonly what: string;
  readonly rule: string;
  readonly watching: string;
  readonly state: 'armed' | 'cannot_be_armed';
  readonly blockedReason: string | null;
  readonly firedCount: number;
  readonly lastFiredAt: string | null;
  readonly filedItem: string | null;
  readonly filedNothing: string | null;
  readonly note: string | null;
}

/** One step of the night round (MP-14-8), and where the fact it reports lives. */
export interface NightStepView {
  readonly id: string;
  readonly at: string;
  readonly tone: 'plain' | 'watch' | 'bad';
  readonly what: string;
  readonly who: string;
  readonly say: string;
  readonly cite: {
    readonly kind: 'grants' | 'tripwires' | 'exceptions' | 'task';
    readonly ref: string | null;
    readonly label: string;
  } | null;
}

/** One agent on the roster, with the live grants the caller may see it hold. */
export interface RosterView {
  readonly agentId: string;
  readonly active: boolean;
  readonly liveGrants: number;
}

/**
 * Connections & signal sections 006 to 008 (MP-14-8). Every count is derived
 * from the rows beside it.
 */
export interface ConnectionSignalResult {
  readonly ok: true;
  readonly leases: readonly GrantView[];
  readonly leaseCounts: {
    readonly live: number;
    readonly ranOut: number;
    readonly takenBack: number;
    readonly liveExec: number;
  };
  readonly tripwires: readonly TripwireView[];
  readonly tripwireCounts: { readonly armed: number; readonly cannotBeArmed: number };
  readonly nightRound: {
    readonly roundOn: string;
    readonly steps: readonly NightStepView[];
    readonly notClean: number;
  } | null;
  readonly roster: readonly RosterView[];
}

/** One action class's graduation row for one client (MP-14-10a, section 010). */
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
 * state and asks the server nothing.
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

/**
 * Settings ▸ Workflow triggers (C33): each definition with its released
 * versions, oldest first, and the activations pinned to them. Definitions
 * carry no client, so the registry is the business's and nothing in it is
 * filtered by client.
 */
export interface AutomationRegistryResult {
  readonly ok: true;
  readonly definitions: readonly AutomationDefinitionView[];
}

export interface AutomationDefinitionView {
  readonly id: string;
  readonly kind: 'skill' | 'automation';
  readonly name: string;
  readonly versions: readonly DefinitionVersionView[];
  readonly activations: readonly ActivationView[];
}

export interface DefinitionVersionView {
  readonly id: string;
  readonly number: number;
  readonly contentDigest: string;
  readonly contentSize: number;
  readonly modes: readonly ('manual' | 'scheduled' | 'event')[];
  readonly releasedBy: string;
  readonly releasedAt: string;
}

export interface ActivationView {
  readonly id: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly mode: 'manual' | 'scheduled' | 'event';
  readonly everyMinutes: number | null;
  readonly eventKind: string | null;
  readonly enabled: boolean;
  readonly changedBy: string;
  readonly changedAt: string;
  readonly revision: number;
  /** The standing approval the activation names (C52-A), revoked or not, or null. */
  readonly approval: StandingApprovalView | null;
}

export interface StandingApprovalView {
  readonly id: string;
  readonly versionId: string;
  readonly act: 'adopted' | 'rolled_back';
  readonly decidedBy: string;
  readonly revoked: boolean;
}
