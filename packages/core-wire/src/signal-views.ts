// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal sections 006 to 008 (MP-14-8): grants, tripwires and
// the night round, as `connection.signal` answers them.

/**
 * One grant: a delegation, a named agent's time-boxed claim for one job.
 * `access` is `exec` when any of its actions is more than a read.
 * `redemptions` counts its agent's applied calls on its task inside its
 * window, less the pickup; nothing records what each reached. `client` is
 * null for a fleet grant; its label is the client's name as `clients` holds
 * it, not the tripwire and step columns' closed grammar, and null when no
 * `clients` row answers its id (`records.uuid_7` has no foreign key). A child
 * grant whose parent ended first carries the time and cause of what ended the
 * parent first: taken back only when that was a revocation. A child grant's
 * `expiresAt` is the earlier of its own expiry and its parent's, since it
 * stands only while its parent does. `expiresAt` is when a grant was due to
 * end. `endedAt` is when its parent ended it, or when it was taken back or
 * settled: handed back, or settled when its agent was next minted a grant
 * for the same purpose after it ran out. It is null for a live grant and for
 * one that ran out at its own expiry and was never settled, and can fall
 * before or after `expiresAt`.
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

/** One tripwire. An unarmable one carries no firing history. */
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

/** One step of the night round, and where the fact it reports lives. */
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

/** Every count is derived from the rows beside it. */
export interface ConnectionSignalResult {
  readonly ok: true;
  readonly grants: readonly GrantView[];
  readonly grantCounts: {
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
