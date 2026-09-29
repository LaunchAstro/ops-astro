// SPDX-License-Identifier: AGPL-3.0-only
//
// The rows `readTaskProposals` reads, and how a version row and a reservation
// row become the views a task page shows. The decision chain is mapped in
// `proposals.ts` itself, beside the fields each payload format signed.
//
// Every value is the stored one, converted only in spelling: numeric text to a
// number, a JSON timestamp to the ISO string a `Date` read gives. Nothing here
// recomputes what the database holds.

import type { ProposalVersionView, ReservationView } from '../../../core-wire/src/index.ts';

export interface VersionRow {
  readonly lineage_id: string;
  readonly lineage_state: string;
  readonly version_id: string;
  readonly version: string;
  readonly purpose: string;
  readonly maximum_minor: string;
  readonly currency: string;
  readonly payload_digest: string;
  readonly payload: unknown;
  readonly superseded_at: string | null;
  readonly run_id: string | null;
  readonly evidence_pack_id: string | null;
  readonly evidence_renderer: string | null;
  readonly evidence_digest: string | null;
  readonly evidence_body: unknown;
  readonly gate_id: string | null;
  readonly gate_state: string | null;
  readonly gate_round: number | null;
  readonly gate_expires_at: string | null;
  readonly gate_expired: boolean | null;
}

export interface ReservationRow {
  readonly lineage_id: string;
  readonly id: string;
  readonly state: string;
  readonly held_minor: string;
  readonly actual_minor: string | null;
  readonly classified_cause: string | null;
  readonly lease_id: string | null;
  readonly lease_fence: string | null;
  readonly lease_state: string | null;
  readonly lease_expires_at: string | null;
  readonly lease_holder: string | null;
  readonly attempt_id: string | null;
  readonly attempt_state: string | null;
  readonly attempt_dispatch_marker: boolean | null;
  readonly attempt_observed: boolean | null;
  readonly attempt_drop_cause: string | null;
}

export interface CheckRow {
  readonly version_id: string;
  readonly id: string;
  readonly name: string;
  readonly outcome: string;
  readonly note: string | null;
  readonly actor_id: string;
  readonly created_at: string;
}

export function asVersion(row: VersionRow, checks: readonly CheckRow[]): ProposalVersionView {
  return {
    versionId: row.version_id,
    version: Number(row.version),
    purpose: row.purpose,
    maximumMinor: Number(row.maximum_minor),
    currency: row.currency,
    payloadDigest: row.payload_digest,
    payload: row.payload,
    supersededAt: row.superseded_at === null ? null : isoTime(row.superseded_at),
    runId: row.run_id,
    evidence:
      row.evidence_pack_id === null
        ? null
        : {
            id: row.evidence_pack_id,
            renderer: row.evidence_renderer ?? 'unknown',
            digest: row.evidence_digest ?? '',
            body: row.evidence_body,
          },
    gate:
      row.gate_id === null
        ? null
        : {
            id: row.gate_id,
            state: row.gate_state ?? 'unknown',
            round: row.gate_round ?? 0,
            expiresAt: isoTime(row.gate_expires_at),
            expired: row.gate_expired ?? false,
            payloadDigest: row.payload_digest,
          },
    checks: checks
      .filter((check) => check.version_id === row.version_id)
      .map((check) => ({
        id: check.id,
        name: check.name,
        outcome: check.outcome,
        note: check.note,
        performedByActorId: check.actor_id,
        recordedAt: isoTime(check.created_at),
      })),
  };
}

/** One reservation with the lease and attempt it produced, if any. */
export function asReservation(row: ReservationRow): ReservationView {
  return {
    id: row.id,
    state: row.state,
    heldMinor: Number(row.held_minor),
    actualMinor: row.actual_minor === null ? null : Number(row.actual_minor),
    releasedMinor:
      row.actual_minor === null ? null : Number(row.held_minor) - Number(row.actual_minor),
    classifiedCause: row.classified_cause,
    leaseId: row.lease_id,
    lease:
      row.lease_id === null
        ? null
        : {
            id: row.lease_id,
            fence: Number(row.lease_fence ?? '0'),
            state: row.lease_state ?? 'unknown',
            expiresAt: isoTime(row.lease_expires_at),
            holderActorId: row.lease_holder,
          },
    attempt:
      row.attempt_id === null
        ? null
        : {
            id: row.attempt_id,
            state: row.attempt_state ?? 'unknown',
            dispatchMarker: row.attempt_dispatch_marker ?? false,
            observed: row.attempt_observed ?? false,
            dropCause: row.attempt_drop_cause,
          },
  };
}

/**
 * A timestamp from the snapshot's JSON, in the spelling a `Date` read gives:
 * milliseconds, UTC. A missing one reads as the epoch, as it did before.
 */
function isoTime(text: string | null): string {
  return new Date(text ?? 0).toISOString();
}
