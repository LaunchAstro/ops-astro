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
// **`versionId` is in the projection because the decision takes it.** The
// runtime's `decide` compares the version the caller names against the live one
// and refuses `VERSION_SUPERSEDED` when they differ, which is only a real
// protection if the caller got the identifier from the same read that showed
// them the evidence. A page that offered "approve" without naming a version
// would be a page that approves whatever arrived last.
//
// **The decision chain is the stored rows, hash and all, and verified.** Each
// link carries its own hash and the one before it, so a reader with the chain
// can check it rather than trust the server's summary of it. The values
// returned are the stored ones, never recomputed: handing back a recomputed
// value as if it were the stored one would make a tampered row unnoticeable.
// But they are returned only after `readVerifiedDecisions` has checked each
// one against its persisted payload, signature and place in the business
// chain (G02, T2). A decision that does not verify fails the whole read with
// `DecisionIntegrityError`; see `verified-decisions.ts`.
//
// The evidence pack's body is the renderer's output as stored. It is not
// re-rendered on read: an evidence pack that changed between the decision and
// the display is the one thing a gate cannot survive.
//
// **The whole answer is one snapshot.** The versions, their gates, the
// decisions, the reservations and each lease's scope (`run-scopes.ts`) are
// read in one statement, the one that reads
// the decision chain (`readVerifiedProjection`). Read separately, a
// `task.decide` committed between them answers a gate `pending` beside its
// own verified `approve`, and the page offers to decide a gate already
// decided. One statement sees the decide entirely or not at all.
//
// **A pending gate past its deadline reads `expired`.** This is Nathan's
// decision of 23 September 2026: show expired on read, preserve the stored
// record. Nothing writes `expired` to `gates.state` (no timer, no migration),
// so the stored row stays `pending` and this read derives the state instead.
// Three rules keep the derivation honest:
// - the clock is the database's `now()`, inside the statement that reads the
//   gate, never the application's;
// - the boundary is inclusive, `expires_at <= now()`, the same predicate as
//   the decide path's `GATE_EXPIRED` refusal (`core-runtime/src/decide.ts`),
//   so the page never offers a decision that the refusal would turn down;
// - only an otherwise pending gate expires. An approved, rejected, sent-back
//   or superseded gate reads its stored outcome whatever the clock says.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import { keyResolver, gateSigningKey } from '../../../core-runtime/src/index.ts';
import type { KeyResolver, SigningKey } from '../../../core-runtime/src/index.ts';
import { readVerifiedProjection } from './verified-decisions.ts';
import { SCOPES, scopesOf, type ScopeRow } from './run-scopes.ts';
import { ENVELOPES, ledgerOf, type EnvelopeRow } from './task-ledger.ts';
import type {
  ProposalVersionView,
  ProposalView,
  TaskLedgerView,
} from '../../../core-wire/src/index.ts';

/** What each payload format signed, in `DecisionLink`'s names (`signing.ts`). */
const SIGNED_FIELDS: Readonly<Record<number, readonly string[]>> = {
  1: ['decision', 'decidedByPersonId', 'signingKeyId'],
  2: ['decision', 'decidedByPersonId', 'signingKeyId'],
  3: [
    'id',
    'seq',
    'decision',
    'round',
    'decidedByPersonId',
    'decidedAt',
    'signingKeyId',
    'prevHash',
  ],
};

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

interface ReservationRow {
  readonly lineage_id: string;
  readonly id: string;
  readonly envelope_id: string;
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
}

interface CheckRow {
  readonly version_id: string;
  readonly id: string;
  readonly name: string;
  readonly outcome: string;
  readonly note: string | null;
  readonly actor_id: string;
  readonly created_at: string;
}

/** The task's lineages that have a version: the scope of the read. */
const LINEAGES = `select distinct ver.lineage_id
       from public.proposal_lineages lin
       join public.proposal_versions ver
         on ver.business_id = lin.business_id and ver.lineage_id = lin.id
      where lin.business_id = $1 and lin.task_id = $2::uuid`;

const VERSIONS = `select row_number() over (order by lin.created_at desc, lin.id, ver.version desc)
                              as ordinal,
            lin.id                as lineage_id,
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
            case when g.state = 'pending' and g.expires_at <= now()
                 then 'expired' else g.state end as gate_state,
            g.round               as gate_round,
            g.expires_at          as gate_expires_at,
            (g.state = 'pending' and g.expires_at <= now()) as gate_expired
       from public.proposal_lineages lin
       join public.proposal_versions ver
         on ver.business_id = lin.business_id and ver.lineage_id = lin.id
       left join public.planned_runs run
         on run.business_id = ver.business_id and run.version_id = ver.id
       left join public.evidence_packs pack
         on pack.business_id = ver.business_id and pack.version_id = ver.id
       left join public.gates g
         on g.business_id = ver.business_id and g.version_id = ver.id
      where lin.business_id = $1 and lin.task_id = $2::uuid`;

const RESERVATIONS = `select row_number() over (order by res.created_at, res.id) as ordinal,
            run.lineage_id,
            res.id, res.envelope_id, res.state, res.held_minor::text as held_minor,
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
      where res.business_id = $1
        and run.lineage_id in (select lineage_id from lineages)`;

const CHECKS = `select row_number() over (order by ck.created_at, ck.id) as ordinal,
            ck.version_id, ck.id, ck.name, ck.outcome, ck.note, ck.actor_id, ck.created_at
       from public.run_checks ck
       join public.proposal_versions ver
         on ver.business_id = ck.business_id and ver.id = ck.version_id
      where ck.business_id = $1
        and ver.lineage_id in (select lineage_id from lineages)`;

/**
 * Every proposal on one task, newest lineage first.
 *
 * `signingKey` is the deployment's keys, from the environment, and a test
 * names its own key or resolver. `null` means none is configured: a task with
 * decisions then fails `DecisionIntegrityError` rather than show them
 * unverified.
 *
 * It is one statement with one aggregate per shape rather than one join across
 * all of them, because a lineage with three versions, four decisions and two
 * reservations joined flat is one row per combination and the reader has to
 * undo the multiplication. Each shape is small and bounded by the lineage.
 */
export async function readTaskProposals(
  tx: TenantQuery,
  taskId: string,
  signingKey: KeyResolver | SigningKey | null = configuredKeys(),
): Promise<readonly ProposalView[]> {
  return (await readTaskWork(tx, taskId, signingKey)).proposals;
}

/** The proposals and the token ledger (MP-6-5) together, from the one statement. */
export async function readTaskWork(
  tx: TenantQuery,
  taskId: string,
  signingKey: KeyResolver | SigningKey | null = configuredKeys(),
): Promise<{ readonly proposals: readonly ProposalView[]; readonly ledger: TaskLedgerView }> {
  const snapshot = await readVerifiedProjection(
    tx,
    {
      lineages: LINEAGES,
      rows: {
        versions: VERSIONS,
        reservations: RESERVATIONS,
        checks: CHECKS,
        scopes: SCOPES,
        envelopes: ENVELOPES,
      },
      parameter: taskId,
    },
    signingKey,
  );
  const versions = (snapshot.rows['versions'] ?? []) as readonly VersionRow[];
  const reservations = (snapshot.rows['reservations'] ?? []) as readonly ReservationRow[];
  const checks = (snapshot.rows['checks'] ?? []) as readonly CheckRow[];
  const scopes = (snapshot.rows['scopes'] ?? []) as readonly ScopeRow[];
  const decisions = snapshot.decisions;
  const ledger = ledgerOf((snapshot.rows['envelopes'] ?? []) as readonly EnvelopeRow[]);
  if (versions.length === 0) return { proposals: [], ledger };

  const lineageIds = [...new Set(versions.map((row) => row.lineage_id))];

  const proposals = lineageIds.map((lineageId) => {
    const rows = versions.filter((row) => row.lineage_id === lineageId);
    const first = rows[0];
    return {
      lineageId,
      state: first?.lineage_state ?? 'unknown',
      versions: rows.map((row) => asVersion(row, checks)),
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
          linkVersion: row.link_version,
          signedFields: SIGNED_FIELDS[row.link_version] ?? [],
        })),
      reservations: reservations
        .filter((row) => row.lineage_id === lineageId)
        .map((row) => ({
          id: row.id,
          envelopeId: row.envelope_id,
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
                },
        })),
      scopes: scopesOf(scopes, lineageId),
    };
  });
  return { proposals, ledger };
}

function asVersion(row: VersionRow, checks: readonly CheckRow[]): ProposalVersionView {
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

/**
 * A timestamp from the snapshot's JSON, in the spelling a `Date` read gives:
 * milliseconds, UTC. A missing one reads as the epoch, as it did before.
 */
function isoTime(text: string | null): string {
  return new Date(text ?? 0).toISOString();
}

/**
 * The keys a read verifies with: the one configured key, as the resolver's
 * only entry. Retaining an older key id is a configuration change that adds
 * an entry here, and it belongs with the key configuration, not in the read.
 */
function configuredKeys(): KeyResolver | null {
  const key = gateSigningKey();
  return key === undefined ? null : keyResolver([key]);
}
