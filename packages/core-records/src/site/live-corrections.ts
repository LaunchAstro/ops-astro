// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's records: the live correction, its decision and its receipts (0311).
//
// Every read here filters by the caller's grant inside the query, at the
// correction's own party, so a party-scoped grant on one client's site reaches
// no other client's correction and a caller with no grant meets the same
// answer as a correction that does not exist. The writes lock the row they
// judge, and the approval reads the configured approver under a share lock on
// its setting, so an approver changed at the same moment is either seen or
// waited for, never half-read.
//
// The system write that records an observed publish or revert with its
// receipt is `correction-receipts.ts`; the decision read, `correction-decisions.ts`.

import { randomUUID } from 'node:crypto';
import { EFFECTIVE, askedFor, type Subject } from '../authority/grants.ts';
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
  /** The version digest the decision approved; the storage keeps it the pinned one. */
  readonly decidedVersionDigest: string | null;
  readonly revision: number;
}

export type NewLiveCorrection = Omit<
  LiveCorrection,
  'id' | 'state' | 'decidedByPersonId' | 'decidedVersionDigest' | 'revision' | 'versionId'
>;

const COLUMNS = `c.id, c.party_id, c.task_id, c.requested_by_actor_id, c.requested_by_person_id,
  c.delegation_id, c.target_path, c.word, c.replacement, c.page_url, c.pre_image_digest,
  c.base_revision, c.seam, c.version_id, c.version_digest, c.state, c.decided_by_person_id,
  c.decided_version_digest, c.revision`;

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
  readonly decided_version_digest: string | null;
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
    decidedVersionDigest: row.decided_version_digest,
    revision: row.revision,
  };
}

/** The one refusal of a request: its party is not the client of a live task. */
export type PartyRefused = { readonly ok: false; readonly code: 'CORRECTION_PARTY_MISMATCH' };

/**
 * Store a request at its task's own client (the `client` link), read in the insert under a share
 * lock on the task: a party the task does not carry, a record that is no task, or a trashed task
 * is refused `CORRECTION_PARTY_MISMATCH`, writing nothing. The version id is minted here.
 */
export async function insertLiveCorrection(
  tx: TenantQuery,
  input: NewLiveCorrection,
): Promise<LiveCorrection | PartyRefused> {
  const [row] = await tx.query<Row>(
    `insert into public.live_corrections as c
       (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
        delegation_id, target_path, word, replacement, page_url, pre_image_digest,
        base_revision, seam, version_id, version_digest)
     select r.business_id, $2::uuid, r.uuid_7, r.id, $5::uuid, $6::uuid, $7::uuid, $8::text,
            $9::text, $10::text, $11::text, $12::text, $13::text, $14::text, $15::uuid,
            $16::text
       from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $4::uuid and t.key = 'task' and r.uuid_7 = $3::uuid
        and r.deleted_at is null for share of r
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
  return row === undefined ? { ok: false, code: 'CORRECTION_PARTY_MISMATCH' } : correctionFrom(row);
}

/**
 * One correction by its id, locked, with no grant filter: the system's read
 * for the runner, whose authority is the worker lease on the correction's own
 * task (`correction-receipts.ts` checks it in the same transaction).
 */
export async function lockCorrectionForSystem(
  tx: TenantQuery,
  id: string,
): Promise<LiveCorrection | undefined> {
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and c.id = $2
      for update of c`,
    [tx.businessId, id],
  );
  const [row] = rows;
  return row === undefined ? undefined : correctionFrom(row);
}

export const COVERED = `exists (
    select 1 from effective e
     where e.collection = $2 and e.action = $3
       and exists (select 1 from unnest($4::text[], $5::uuid[]) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id)
       and (e.scope_kind = 'business' or (e.scope_kind = 'party' and e.scope_id = c.party_id)))`;

export interface Covering {
  readonly subjects: readonly Subject[];
  readonly collection: string;
  readonly action: string;
}

/**
 * The query's parameters, with only the subjects asked about this key: an
 * agent credential's person counts within the keys it ticked (API-2), so the
 * guarantee lives here and not in each caller.
 */
export const coveringParameters = (covering: Covering): readonly unknown[] => {
  const asked = askedFor(covering.subjects, covering);
  return [
    covering.collection,
    covering.action,
    asked.map((subject) => subject.kind),
    asked.map((subject) => subject.id),
  ];
};

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

/** Every correction the caller's run:write reaches (ORCH33), newest first, filtered in the query. */
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
      ...coveringParameters({ subjects, collection: RUN_COLLECTION, action: 'write' }),
    ],
  );
  return rows.map((row) => correctionFrom(row));
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

/** Whether a person is an active member here in a staff role, as `isInternalReader` admits. */
export async function isActiveMember(tx: TenantQuery, personId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly present: boolean }>(
    `select true as present from public.memberships where business_id = $1 and person_id = $2
        and active and ended_at is null and role_key in ('owner', 'admin', 'member')`,
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

/**
 * Write the decision on a row the caller has already locked and judged. The
 * decision records the version digest of the version the approver named.
 */
export async function writeCorrectionDecision(
  tx: TenantQuery,
  write: DecisionWrite,
): Promise<LiveCorrection> {
  const rows = await tx.query<Row>(
    `update public.live_corrections as c
        set state = $3, decided_by_actor_id = $4, decided_by_person_id = $5,
            decided_at = now(), decided_version_digest = c.version_digest,
            revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'requested'
      returning ${COLUMNS}`,
    [tx.businessId, write.id, write.decision, write.actorId, write.personId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('writeCorrectionDecision: the row left requested');
  return correctionFrom(row);
}
