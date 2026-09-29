// SPDX-License-Identifier: AGPL-3.0-only
//
// The proposal projection the Agent pane reads (MP-6-1): `task.read`'s
// lineages, versions, gates, checks and reservations.
//
// This package imports no `core-*` package, so the shapes it reads are its own,
// the fields of `task.read`'s proposal projection the pane draws. The web
// passes the projection itself; TypeScript holds the two to the same fields.

export interface RunCheck {
  readonly id: string;
  readonly name: string;
  readonly outcome: string;
  readonly note: string | null;
  readonly performedByActorId: string;
  readonly recordedAt: string;
}

export interface RunGate {
  readonly id: string;
  readonly state: string;
  readonly round: number;
  readonly expiresAt: string | null;
  readonly expired: boolean;
  readonly payloadDigest: string;
  /** When the gate was raised (MP-6-2). Absent from a read made before it, which reads as unknown. */
  readonly raisedAt?: string;
}

export interface RunVersion {
  readonly versionId: string;
  readonly version: number;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payloadDigest: string;
  readonly payload: unknown;
  readonly supersededAt: string | null;
  readonly runId: string | null;
  /** When the first lease on this version's run was taken; null before any (MP-6-2). */
  readonly runStartedAt?: string | null;
  readonly evidence: { readonly digest: string; readonly body: unknown } | null;
  readonly gate: RunGate | null;
  readonly checks: readonly RunCheck[];
}

export interface RunReservation {
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  readonly classifiedCause: string | null;
  readonly lease: { readonly state: string } | null;
  readonly attempt: { readonly state: string } | null;
}

/** What a run was allowed to touch: its lease's delegation, set by the broker (MP-6-4). */
export interface RunScope {
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly delegation: {
    readonly id: string;
    readonly purpose: string;
    readonly scope: { readonly kind: string; readonly id: string };
    readonly pairs: readonly { readonly collection: string; readonly action: string }[];
    readonly expiresAt: string;
    readonly state: string;
    readonly delegatePersonId: string;
    readonly grants: readonly {
      readonly id: string;
      readonly collection: string;
      readonly action: string;
      readonly scopeKind: string;
    }[];
  } | null;
}

export interface RunLineage {
  readonly lineageId: string;
  readonly state: string;
  /** Newest first. */
  readonly versions: readonly RunVersion[];
  readonly decisions: readonly {
    readonly decision: string;
    readonly decidedByPersonId: string;
    readonly decidedAt: string;
  }[];
  readonly reservations: readonly RunReservation[];
  /** Oldest lease first. Absent from a read made before MP-6-4, which reads as none. */
  readonly scopes?: readonly RunScope[];
}
