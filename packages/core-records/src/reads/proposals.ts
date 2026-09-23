// SPDX-License-Identifier: AGPL-3.0-only
//
// What a task page needs to show a proposal and offer a decision on it.
//
// A gate is only worth having if the person deciding can see what they are
// deciding. So the projection carries the **stored** version — its number, its
// digest, its rendered evidence pack — beside the gate's own state and expiry,
// the decision chain that has already been written, and the reservation, lease
// and attempt the approval produced.
//
// Two shapes in it are load-bearing rather than convenient.
//
// **`versionId` is in the projection because the decision takes it.** L4's
// `decide` compares the version the caller names against the live one and
// refuses `VERSION_SUPERSEDED` when they differ, which is only a real
// protection if the caller got the identifier from the same read that showed
// them the evidence. A page that offered "approve" without naming a version
// would be a page that approves whatever arrived last.
//
// **The decision chain is the stored rows, hash and all.** Each link carries
// its own hash and the one before it, so a reader with the chain can check it
// rather than trust the server's summary of it. Nothing here recomputes a
// hash; recomputing is `verifyChain`'s, and handing back a recomputed value as
// if it were the stored one would make a tampered row unnoticeable.
//
// The evidence pack's body is the renderer's output as stored. It is not
// re-rendered on read: an evidence pack that changed between the decision and
// the display is the one thing a gate cannot survive.

import type { TenantQuery } from '../tenancy/database.ts';

export interface EvidenceView {
  readonly id: string;
  readonly renderer: string;
  readonly digest: string;
  readonly body: unknown;
}

export interface DecisionLink {
  readonly id: string;
  readonly seq: number;
  readonly decision: string;
  readonly round: number;
  readonly decidedByPersonId: string;
  readonly decidedAt: string;
  readonly signingKeyId: string;
  readonly signature: string;
  readonly prevHash: string;
  readonly hash: string;
}

export interface ReservationView {
  readonly id: string;
  readonly state: string;
  readonly heldMinor: number;
  readonly actualMinor: number | null;
  readonly classifiedCause: string | null;
  readonly leaseId: string | null;
  readonly lease: LeaseView | null;
  readonly attempt: AttemptView | null;
}

export interface LeaseView {
  readonly id: string;
  readonly fence: number;
  readonly state: string;
  readonly expiresAt: string;
  readonly holderActorId: string | null;
}

export interface AttemptView {
  readonly id: string;
  readonly state: string;
  readonly dispatchMarker: boolean;
  readonly observed: boolean;
}

export interface GateView {
  readonly id: string;
  readonly state: string;
  readonly round: number;
  readonly expiresAt: string;
  /** The server's own answer, so a client with a skewed clock cannot disagree. */
  readonly expired: boolean;
  readonly payloadDigest: string;
}

export interface ProposalVersionView {
  readonly versionId: string;
  readonly version: number;
  readonly purpose: string;
  readonly maximumMinor: number;
  readonly currency: string;
  readonly payloadDigest: string;
  readonly payload: unknown;
  readonly supersededAt: string | null;
  readonly runId: string | null;
  readonly evidence: EvidenceView | null;
  readonly gate: GateView | null;
}

export interface ProposalView {
  readonly lineageId: string;
  readonly state: string;
  /** Newest first, so the live version is the head of the list. */
  readonly versions: readonly ProposalVersionView[];
  readonly decisions: readonly DecisionLink[];
  readonly reservations: readonly ReservationView[];
}

interface VersionRow {
  readonly lineage_id: string;
  readonly lineage_state: string;
  readonly version_id: string;
  readonly version: string;
  readonly purpose: string;
  readonly maximum_minor: string;
  readonly currency: string;
  readonly payload_digest: string;
  readonly payload: unknown;
  readonly superseded_at: Date | null;
  readonly run_id: string | null;
  readonly evidence_pack_id: string | null;
  readonly evidence_renderer: string | null;
  readonly evidence_digest: string | null;
  readonly evidence_body: unknown;
  readonly gate_id: string | null;
  readonly gate_state: string | null;
  readonly gate_round: number | null;
  readonly gate_expires_at: Date | null;
  readonly gate_expired: boolean | null;
}

/**
 * Every proposal on one task, newest lineage first.
 *
 * It is one query per shape rather than one join across all of them, because a
 * lineage with three versions, four decisions and two reservations joined flat
 * is one row per combination and the reader has to undo the multiplication.
 * Each of these is small and bounded by the lineage.
 */
export async function readTaskProposals(
  tx: TenantQuery,
  taskId: string,
): Promise<readonly ProposalView[]> {
  const versions = await tx.query<VersionRow>(
    `select lin.id                as lineage_id,
            lin.state             as lineage_state,
            ver.id                as version_id,
            ver.version::text     as version,
            ver.purpose,
            ver.maximum_minor::text as maximum_minor,
            ver.currency,
            ver.payload_digest,
            ver.payload,
            ver.superseded_at,
            run.id                as run_id,
            pack.id               as evidence_pack_id,
            pack.renderer         as evidence_renderer,
            pack.rendered_digest  as evidence_digest,
            pack.rendered         as evidence_body,
            g.id                  as gate_id,
            g.state               as gate_state,
            g.round               as gate_round,
            g.expires_at          as gate_expires_at,
            (g.expires_at <= now()) as gate_expired
       from public.proposal_lineages lin
       join public.proposal_versions ver
         on ver.business_id = lin.business_id and ver.lineage_id = lin.id
       left join public.planned_runs run
         on run.business_id = ver.business_id and run.version_id = ver.id
       left join public.evidence_packs pack
         on pack.business_id = ver.business_id and pack.version_id = ver.id
       left join public.gates g
         on g.business_id = ver.business_id and g.version_id = ver.id
      where lin.business_id = $1 and lin.task_id = $2
      order by lin.created_at desc, ver.version desc`,
    [tx.businessId, taskId],
  );
  if (versions.length === 0) return [];

  const lineageIds = [...new Set(versions.map((row) => row.lineage_id))];

  const decisions = await tx.query<{
    readonly lineage_id: string;
    readonly id: string;
    readonly seq: string;
    readonly decision: string;
    readonly round: number;
    readonly decided_by_person_id: string;
    readonly decided_at: Date;
    readonly signing_key_id: string;
    readonly signature: string;
    readonly prev_hash: string;
    readonly hash: string;
  }>(
    `select lineage_id, id, seq::text as seq, decision, round, decided_by_person_id,
            decided_at, signing_key_id, signature, prev_hash, hash
       from public.gate_decisions
      where business_id = $1 and lineage_id = any($2::uuid[])
      order by seq`,
    [tx.businessId, lineageIds],
  );

  const reservations = await tx.query<{
    readonly lineage_id: string;
    readonly id: string;
    readonly state: string;
    readonly held_minor: string;
    readonly actual_minor: string | null;
    readonly classified_cause: string | null;
    readonly lease_id: string | null;
    readonly lease_fence: string | null;
    readonly lease_state: string | null;
    readonly lease_expires_at: Date | null;
    readonly lease_holder: string | null;
    readonly attempt_id: string | null;
    readonly attempt_state: string | null;
    readonly attempt_dispatch_marker: boolean | null;
    readonly attempt_observed: boolean | null;
  }>(
    `select run.lineage_id,
            res.id, res.state, res.held_minor::text as held_minor,
            res.actual_minor::text as actual_minor, res.classified_cause,
            res.lease_id,
            lease.fence::text as lease_fence, lease.state as lease_state,
            lease.expires_at as lease_expires_at, lease.holder_actor_id as lease_holder,
            att.id as attempt_id, att.state as attempt_state,
            att.dispatch_marker as attempt_dispatch_marker, att.observed as attempt_observed
       from public.reservations res
       join public.planned_runs run
         on run.business_id = res.business_id and run.id = res.run_id
       left join public.leases lease
         on lease.business_id = res.business_id and lease.id = res.lease_id
       left join public.attempts att
         on att.business_id = res.business_id and att.reservation_id = res.id
      where res.business_id = $1 and run.lineage_id = any($2::uuid[])
      order by res.created_at`,
    [tx.businessId, lineageIds],
  );

  return lineageIds.map((lineageId) => {
    const rows = versions.filter((row) => row.lineage_id === lineageId);
    const first = rows[0];
    return {
      lineageId,
      state: first?.lineage_state ?? 'unknown',
      versions: rows.map(asVersion),
      decisions: decisions
        .filter((row) => row.lineage_id === lineageId)
        .map((row) => ({
          id: row.id,
          seq: Number(row.seq),
          decision: row.decision,
          round: row.round,
          decidedByPersonId: row.decided_by_person_id,
          decidedAt: row.decided_at.toISOString(),
          signingKeyId: row.signing_key_id,
          signature: row.signature,
          prevHash: row.prev_hash,
          hash: row.hash,
        })),
      reservations: reservations
        .filter((row) => row.lineage_id === lineageId)
        .map((row) => ({
          id: row.id,
          state: row.state,
          heldMinor: Number(row.held_minor),
          actualMinor: row.actual_minor === null ? null : Number(row.actual_minor),
          classifiedCause: row.classified_cause,
          leaseId: row.lease_id,
          lease:
            row.lease_id === null
              ? null
              : {
                  id: row.lease_id,
                  fence: Number(row.lease_fence ?? '0'),
                  state: row.lease_state ?? 'unknown',
                  expiresAt: (row.lease_expires_at ?? new Date(0)).toISOString(),
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
                },
        })),
    };
  });
}

function asVersion(row: VersionRow): ProposalVersionView {
  return {
    versionId: row.version_id,
    version: Number(row.version),
    purpose: row.purpose,
    maximumMinor: Number(row.maximum_minor),
    currency: row.currency,
    payloadDigest: row.payload_digest,
    payload: row.payload,
    supersededAt: row.superseded_at === null ? null : row.superseded_at.toISOString(),
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
            expiresAt: (row.gate_expires_at ?? new Date(0)).toISOString(),
            expired: row.gate_expired ?? false,
            payloadDigest: row.payload_digest,
          },
  };
}
