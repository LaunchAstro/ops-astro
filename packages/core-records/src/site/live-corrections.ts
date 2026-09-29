// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's records: the live correction, its decision and its receipts (0032).
//
// Every read here filters by the caller's grant inside the query, at the
// correction's own party, so a party-scoped grant on one client's site reaches
// no other client's correction and a caller with no grant meets the same
// answer as a correction that does not exist. The writes lock the row they
// judge, and the approval reads the configured approver under a share lock on
// its setting, so an approver changed at the same moment is either seen or
// waited for, never half-read.
//
// The system write (`recordObservedResult`) moves the state and appends the
// receipt in one statement pair inside the caller's transaction, under a live
// worker lease on the correction's task: if the receipt cannot be written, the
// state does not move (TR-S-R4-10).

import { randomUUID } from 'node:crypto';
import { EFFECTIVE, type Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';

export const RUN_COLLECTION = 'run';
export const GATE_COLLECTION = 'gate';
export const APPROVER_SETTING = 'live_correction_approver';

export type CorrectionState =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'accepted'
  | 'live'
  | 'unknown'
  | 'failed'
  | 'reverted';

export interface LiveCorrection {
  readonly id: string;
  readonly partyId: string;
  readonly taskId: string;
  readonly requestedByActorId: string;
  readonly requestedByPersonId: string;
  readonly delegationId: string | null;
  readonly targetPath: string;
  readonly word: string;
  readonly replacement: string;
  readonly pageUrl: string;
  readonly preImageDigest: string;
  readonly baseRevision: string;
  readonly seam: string;
  readonly versionId: string;
  readonly versionDigest: string;
  readonly state: CorrectionState;
  readonly decidedByPersonId: string | null;
  readonly revision: number;
}

export type NewLiveCorrection = Omit<
  LiveCorrection,
  'id' | 'state' | 'decidedByPersonId' | 'revision' | 'versionId'
>;

const COLUMNS = `c.id, c.party_id, c.task_id, c.requested_by_actor_id, c.requested_by_person_id,
  c.delegation_id, c.target_path, c.word, c.replacement, c.page_url, c.pre_image_digest,
  c.base_revision, c.seam, c.version_id, c.version_digest, c.state, c.decided_by_person_id,
  c.revision`;

interface Row {
  readonly id: string;
  readonly party_id: string;
  readonly task_id: string;
  readonly requested_by_actor_id: string;
  readonly requested_by_person_id: string;
  readonly delegation_id: string | null;
  readonly target_path: string;
  readonly word: string;
  readonly replacement: string;
  readonly page_url: string;
  readonly pre_image_digest: string;
  readonly base_revision: string;
  readonly seam: string;
  readonly version_id: string;
  readonly version_digest: string;
  readonly state: CorrectionState;
  readonly decided_by_person_id: string | null;
  readonly revision: number;
}

function correctionFrom(row: Row): LiveCorrection {
  return {
    id: row.id,
    partyId: row.party_id,
    taskId: row.task_id,
    requestedByActorId: row.requested_by_actor_id,
    requestedByPersonId: row.requested_by_person_id,
    delegationId: row.delegation_id,
    targetPath: row.target_path,
    word: row.word,
    replacement: row.replacement,
    pageUrl: row.page_url,
    preImageDigest: row.pre_image_digest,
    baseRevision: row.base_revision,
    seam: row.seam,
    versionId: row.version_id,
    versionDigest: row.version_digest,
    state: row.state,
    decidedByPersonId: row.decided_by_person_id,
    revision: row.revision,
  };
}

/** Store a request. The version id is minted here: the approval names it back. */
export async function insertLiveCorrection(
  tx: TenantQuery,
  input: NewLiveCorrection,
): Promise<LiveCorrection> {
  const rows = await tx.query<Row>(
    `insert into public.live_corrections as c
       (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
        delegation_id, target_path, word, replacement, page_url, pre_image_digest,
        base_revision, seam, version_id, version_digest)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     returning ${COLUMNS}`,
    [
      tx.businessId,
      randomUUID(),
      input.partyId,
      input.taskId,
      input.requestedByActorId,
      input.requestedByPersonId,
      input.delegationId,
      input.targetPath,
      input.word,
      input.replacement,
      input.pageUrl,
      input.preImageDigest,
      input.baseRevision,
      input.seam,
      randomUUID(),
      input.versionDigest,
    ],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('insertLiveCorrection: no row returned');
  return correctionFrom(row);
}

const COVERED = `exists (
    select 1 from effective e
     where e.collection = $2 and e.action = $3
       and exists (select 1 from unnest($4::text[], $5::uuid[]) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id)
       and (e.scope_kind = 'business' or (e.scope_kind = 'party' and e.scope_id = c.party_id)))`;

interface Covering {
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly action: string;
}

const coveringParameters = (covering: Covering): readonly unknown[] => [
  covering.collection,
  covering.action,
  covering.subjects.map((subject) => subject.kind),
  covering.subjects.map((subject) => subject.id),
];

/**
 * One correction the caller's grant covers at its party, locked for the
 * caller's write, or undefined: absent, in another business, or not covered
 * are one answer.
 */
export async function lockCoveredCorrection(
  tx: TenantQuery,
  id: string,
  covering: Covering,
): Promise<LiveCorrection | undefined> {
  const rows = await tx.query<Row>(
    `${EFFECTIVE}
     select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and c.id = $6 and ${COVERED}
      for update of c`,
    [tx.businessId, ...coveringParameters(covering), id],
  );
  const [row] = rows;
  return row === undefined ? undefined : correctionFrom(row);
}

/** Every correction the caller may read, newest first; the grant filters inside the query. */
export async function listCoveredCorrections(
  tx: TenantQuery,
  subjects: readonly Subject[],
): Promise<readonly LiveCorrection[]> {
  const rows = await tx.query<Row>(
    `${EFFECTIVE}
     select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and ${COVERED}
      order by c.created_at desc, c.id`,
    [
      tx.businessId,
      ...coveringParameters({ subjects, collection: RUN_COLLECTION, action: 'read' }),
    ],
  );
  return rows.map(correctionFrom);
}

/**
 * The configured approver's person id, read under a share lock on its setting
 * row so a concurrent change waits for this decision (or this decision for it).
 * Undefined when the business has no such row or the value is unset.
 */
export async function lockConfiguredApprover(tx: TenantQuery): Promise<string | undefined> {
  const rows = await tx.query<{ readonly value: unknown }>(
    `select value from public.business_settings
      where business_id = $1 and key = $2
      for share`,
    [tx.businessId, APPROVER_SETTING],
  );
  const value = rows[0]?.value;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Whether a person is an active member of this business (an approver must be). */
export async function isActiveMember(tx: TenantQuery, personId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly present: boolean }>(
    `select true as present from public.memberships
      where business_id = $1 and person_id = $2 and active and ended_at is null`,
    [tx.businessId, personId],
  );
  return rows.length > 0;
}

export interface DecisionWrite {
  readonly id: string;
  readonly decision: 'approved' | 'rejected';
  readonly actorId: string;
  readonly personId: string;
}

/** Write the decision on a row the caller has already locked and judged. */
export async function writeCorrectionDecision(
  tx: TenantQuery,
  write: DecisionWrite,
): Promise<LiveCorrection> {
  const rows = await tx.query<Row>(
    `update public.live_corrections as c
        set state = $3, decided_by_actor_id = $4, decided_by_person_id = $5,
            decided_at = now(), revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'requested'
      returning ${COLUMNS}`,
    [tx.businessId, write.id, write.decision, write.actorId, write.personId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('writeCorrectionDecision: the row left requested');
  return correctionFrom(row);
}

export interface ObservedResult {
  readonly correctionId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly step: 'publish' | 'revert';
  readonly outcome: 'accepted' | 'live' | 'unknown' | 'failed' | 'reverted';
  readonly observations: Readonly<Record<string, unknown>>;
}

/** The states each step may move from. A publish needs the approval; a revert a live page. */
const FROM: Readonly<Record<ObservedResult['step'], readonly CorrectionState[]>> = {
  publish: ['approved', 'accepted', 'unknown'],
  revert: ['live'],
};

export type ObservedRefusal = 'LEASE_NOT_OWNED' | 'NOT_FOUND' | 'GATE_NOT_APPROVED';

/**
 * `receipt written`: the observed result and its receipt, together.
 *
 * Under a live worker lease on the correction's task with the fence the worker
 * holds, both locked; the correction row locked next. The state moves and the
 * receipt is appended in this transaction, so a receipt that fails to write
 * leaves no moved state behind it, and a state never moves without its receipt.
 */
export async function recordObservedResult(
  tx: TenantQuery,
  result: ObservedResult,
): Promise<
  | { readonly ok: true; readonly receiptId: string }
  | { readonly ok: false; readonly code: ObservedRefusal }
> {
  const correction = await tx.query<{ readonly task_id: string; readonly state: CorrectionState }>(
    `select task_id, state from public.live_corrections
      where business_id = $1 and id = $2 for update`,
    [tx.businessId, result.correctionId],
  );
  const row = correction[0];
  if (row === undefined) return { ok: false, code: 'NOT_FOUND' };
  const lease = await tx.query<{ readonly id: string }>(
    `select id from public.leases
      where business_id = $1 and id = $2 and task_id = $3 and fence = $4
        and state = 'live' and expires_at > now()
      for share`,
    [tx.businessId, result.leaseId, row.task_id, result.fence],
  );
  if (lease.length === 0) return { ok: false, code: 'LEASE_NOT_OWNED' };
  if (!FROM[result.step].includes(row.state)) return { ok: false, code: 'GATE_NOT_APPROVED' };

  await tx.query(
    `update public.live_corrections
        set state = $3, revision = revision + 1, updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, result.correctionId, result.outcome],
  );
  const receiptId = randomUUID();
  await tx.query(
    `insert into public.live_correction_receipts
       (business_id, id, correction_id, lease_id, fence, step, outcome, observations)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      tx.businessId,
      receiptId,
      result.correctionId,
      result.leaseId,
      result.fence,
      result.step,
      result.outcome,
      JSON.stringify(result.observations),
    ],
  );
  return { ok: true, receiptId };
}
