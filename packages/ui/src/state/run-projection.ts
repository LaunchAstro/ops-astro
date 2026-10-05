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
}

/** The run's pinned definition reference: a skill file by path, or a definition version. */
export interface RunPin {
  readonly kind: string;
  readonly path: string | null;
  readonly digest: string;
  readonly definitionVersionId: string | null;
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
  /** The run's first claim and a hand-back with none after it (MP-6-2); absent on an older read. */
  readonly startedAt?: string | null;
  readonly endedAt?: string | null;
  /** The token units the run's model calls recorded (MP-6-2); absent on an older read. */
  readonly tokenUnits?: number | null;
  /** What the run was given at its start (MP-6-2, TA-09); absent on an older read. */
  readonly pins?: readonly RunPin[];
  readonly evidence: { readonly digest: string; readonly body: unknown } | null;
  readonly gate: RunGate | null;
  readonly checks: readonly RunCheck[];
}

export interface RunReservation {
  /**
   * The reservation, the task envelope it holds against and the run it holds
   * for (MP-6-5). Absent from a read made before MP-6-5, which draws no
   * per-run rows.
   */
  readonly id?: string;
  readonly envelopeId?: string;
  readonly runId?: string;
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  readonly classifiedCause: string | null;
  readonly lease: { readonly state: string } | null;
  /**
   * The step's attempt. Its id names it to `budget.record_outcome` and
   * `budget.write_off` (C54); absent on a read that does not carry it.
   */
  readonly attempt: {
    readonly id?: string;
    readonly state: string;
    /** What the attempt recorded, or null before it records (OW-108.1). */
    readonly outcome: string | null;
  } | null;
}

/** What a run was allowed to touch: its lease's delegation, set by the broker (MP-6-4). */
export interface RunScope {
  readonly leaseId: string;
  readonly acquiredAt: string;
  readonly delegation: {
    readonly id: string;
    readonly purpose: string;
    readonly scope: { readonly kind: string; readonly id: string };
    readonly collections: readonly string[];
    readonly actions: readonly string[];
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

/** An attempt held with its effect unknown, as a person answers for it (C54). */
export interface UnknownAttempt {
  readonly id: string;
  readonly heldMinor: number;
}

/** The newest attempt, when it is held with its effect unknown and named (C54). */
export function unknownOf(reservation: RunReservation | undefined): UnknownAttempt | null {
  const id = reservation?.attempt?.id;
  if (reservation?.state !== 'held' || reservation.attempt?.state !== 'liability_unknown') {
    return null;
  }
  return typeof id === 'string' ? { id, heldMinor: reservation.heldMinor } : null;
}

/**
 * The newest reservation for the head's run. A read made before MP-6-5 names
 * no run, so each of its reservations counts.
 */
function ownReservation(lineage: RunLineage, head: RunVersion): RunReservation | undefined {
  return lineage.reservations.findLast(
    (reservation) => reservation.runId === undefined || reservation.runId === head.runId,
  );
}

/**
 * The reservation that matters now. A hold whose effect is unknown stays
 * reserved until a person answers, on whatever run it was for (C54), so it
 * decides first: a hand-back with a successor leaves one on the old run.
 * Otherwise the head's run decides; an older version's run says nothing of it.
 */
export function headReservation(lineage: RunLineage, head: RunVersion): RunReservation | undefined {
  const unknown = lineage.reservations.findLast(
    (reservation) =>
      reservation.state === 'quarantined' || reservation.attempt?.state === 'liability_unknown',
  );
  return unknown ?? ownReservation(lineage, head);
}

/**
 * What the story holds: the reservation that matters, and beside an unknown
 * hold on an older run, the head run's own as well.
 */
export function heldMinorOf(lineage: RunLineage, head: RunVersion): number {
  const decides = headReservation(lineage, head);
  const own = ownReservation(lineage, head);
  return (decides?.heldMinor ?? 0) + (own === undefined || own === decides ? 0 : own.heldMinor);
}
