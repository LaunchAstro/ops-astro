// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's records: the live correction, its decision and its receipts (0311).
//
// Every read here filters by the caller's grant inside the query, at the
// correction's own party (none on the business's own site, R6: business-wide
// grants only), so a party-scoped grant on one client's site reaches no other
// client's correction and a caller with no grant meets the same answer as a
// correction that does not exist. The writes lock the row they judge, and the
// approval reads the configured approver under a share lock on its setting, so
// an approver changed at the same moment is either seen or waited for.
//
// The system write that records an observed publish or revert with its
// receipt is `correction-receipts.ts`; the decision read, its write and the
// approver reads, `correction-decisions.ts`; the grant filter and its lock, `covering.ts`.

import { randomUUID } from 'node:crypto';
import type { Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { shareClientSite, taskClient } from './party-sites.ts';
import {
  COVERED,
  EFFECTIVE_AT,
  coveringParameters,
  holdCoveringGrants,
  type Covering,
} from './covering.ts';

export const RUN_COLLECTION = 'run';
export const GATE_COLLECTION = 'gate';
export const APPROVER_SETTING = 'live_correction_approver';

export type CorrectionState =
  | 'locating'
  | 'unlocated'
  | 'requested'
  | 'superseded'
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
  /** The task's client, whose site it is; null for the business's own site. */
  readonly partyId: string | null;
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
  readonly singleOperatorSelfApproval: boolean;
  readonly revision: number;
}

type PinKey = 'preImageDigest' | 'baseRevision' | 'versionId' | 'versionDigest';

/**
 * A correction the site runner has not pinned (#1693): `locating`, `unlocated`, or cancelled
 * before it was located. It names no version, so nothing can decide or run it.
 */
export type UnpinnedCorrection = Omit<LiveCorrection, PinKey> & {
  readonly [K in PinKey]: null;
};

/** Any stored correction: pinned (`LiveCorrection`) or not yet. */
export type StoredCorrection = LiveCorrection | UnpinnedCorrection;

/**
 * A request as the door sends it (#1693): the task, the page as the person typed it, and the two
 * words. The site, its page and file are resolved in the insert; the version is pinned later by
 * the site runner from the file itself, never taken from a caller.
 */
export interface NewLiveCorrection {
  readonly taskId: string;
  readonly requestedByActorId: string;
  readonly requestedByPersonId: string;
  readonly delegationId: string | null;
  /** The page's exact address, or its last path segment in any case (`home` for the root). */
  readonly page: string;
  readonly word: string;
  readonly replacement: string;
  readonly seam: string;
  readonly planVersionId?: string | null;
}

export const COLUMNS = `c.id, c.party_id, c.task_id, c.requested_by_actor_id, c.requested_by_person_id,
  c.delegation_id, c.target_path, c.word, c.replacement, c.page_url, c.pre_image_digest,
  c.base_revision, c.seam, c.version_id, c.version_digest, c.state, c.decided_by_person_id,
  c.decided_version_digest, c.single_operator_self_approval, c.revision`;

export interface Row {
  readonly id: string;
  readonly party_id: string | null;
  readonly task_id: string;
  readonly requested_by_actor_id: string;
  readonly requested_by_person_id: string;
  readonly delegation_id: string | null;
  readonly target_path: string;
  readonly word: string;
  readonly replacement: string;
  readonly page_url: string;
  readonly pre_image_digest: string | null;
  readonly base_revision: string | null;
  readonly seam: string;
  readonly version_id: string | null;
  readonly version_digest: string | null;
  readonly state: CorrectionState;
  readonly decided_by_person_id: string | null;
  readonly decided_version_digest: string | null;
  readonly single_operator_self_approval: boolean;
  readonly revision: number;
}

export function correctionFrom(row: Row): StoredCorrection {
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
    singleOperatorSelfApproval: row.single_operator_self_approval,
    revision: row.revision,
  } as StoredCorrection;
}

/** A row read only where it is pinned (`c.pre_image_digest is not null` in its query). */
export const pinnedFrom = (row: Row): LiveCorrection => correctionFrom(row) as LiveCorrection;

/** A request's refusal: the task's own site holds no one page by that name. */
export interface PageRefused {
  readonly ok: false;
  readonly code: 'PAGE_NOT_FOUND';
}

/**
 * The last path segment of a page's address, in lower case, or `home` for the site's root: the
 * name a person may type for it.
 */
const PAGE_NAME = `coalesce(nullif(lower(regexp_replace(regexp_replace(
    regexp_replace(p.page_url, '^[a-z]+://[^/]+', ''), '/+$', ''), '^.*/', '')), ''), 'home')`;

/**
 * Store a request `locating` on its task's own site (#1693). The holder is the task's client, read
 * in the insert under a share lock on the task, or the business itself for a task with no client
 * (R6). The typed page, trimmed, names a page of that holder's site only, inside the query: its
 * exact address, or its last path segment in any case. Exactly one match stores the request with
 * that page's address and file; none, more than one, another holder's page or an unbound name is
 * one `PAGE_NOT_FOUND`, storing nothing and telling no id, address or count. The page is key-share
 * locked so an unbind waits for the request, and the site row share-locked so a move of its
 * providers does too; the site row is share-locked first, on its own, as an unbind takes the site
 * before the page. No pin is stored: the site runner pins the version from the file itself.
 */
export async function insertLiveCorrection(
  tx: TenantQuery,
  input: NewLiveCorrection,
): Promise<StoredCorrection | PageRefused> {
  const client = await taskClient(tx, input.taskId);
  if (client !== undefined) await shareClientSite(tx, client);
  const [row] = await tx.query<Row>(
    `with task as (
       select r.business_id, r.id, r.uuid_7 from public.records r
         join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
        where r.business_id = $1 and r.id = $3::uuid and t.key = 'task' and r.deleted_at is null
          for share of r),
     named as (
       select p.page_url, p.path from task
         join public.party_site_pages p
           on p.business_id = task.business_id and p.holder = coalesce(task.uuid_7, task.business_id)
         join public.party_sites s on s.business_id = p.business_id and s.holder = p.holder
        where p.page_url = $8::text or ${PAGE_NAME} = lower($8::text)
          for key share of p for share of s)
     insert into public.live_corrections as c
       (business_id, id, party_id, task_id, requested_by_actor_id, requested_by_person_id,
        delegation_id, target_path, word, replacement, page_url, seam, state, plan_version_id)
     select task.business_id, $2::uuid, task.uuid_7, task.id, $4::uuid, $5::uuid, $6::uuid,
            named.path, $9::text, $10::text, named.page_url, $7::text, 'locating', $11::uuid
       from task, named
      where (select count(*) from named) = 1
     on conflict (business_id, plan_version_id) where plan_version_id is not null do nothing
     returning ${COLUMNS}`,
    [
      tx.businessId,
      randomUUID(),
      input.taskId,
      input.requestedByActorId,
      input.requestedByPersonId,
      input.delegationId,
      input.seam,
      input.page.trim(),
      input.word,
      input.replacement,
      input.planVersionId ?? null,
    ],
  );
  return row === undefined ? { ok: false, code: 'PAGE_NOT_FOUND' } : correctionFrom(row);
}

/**
 * One correction by its id on `taskId`, locked, with no grant filter: the
 * system's read for the runner, whose authority is the worker lease on that
 * task (`correction-receipts.ts` checks it in the same transaction). A
 * correction on another task, or one not pinned yet (#1693), is not read,
 * locked or told apart from none.
 */
export async function lockCorrectionForSystem(
  tx: TenantQuery,
  id: string,
  taskId: string,
): Promise<LiveCorrection | undefined> {
  const rows = await tx.query<Row>(
    `select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and c.id = $2 and c.task_id = $3
        and c.pre_image_digest is not null
      for update of c`,
    [tx.businessId, id, taskId],
  );
  const [row] = rows;
  return row === undefined ? undefined : pinnedFrom(row);
}

/**
 * One correction the caller's grant covers at its party, locked for the
 * caller's write, or undefined: absent, in another business, or not covered
 * are one answer.
 *
 * The grant is judged twice: in the locking read, so a caller it does not
 * cover never waits on the row, and again once the lock is held and the
 * covering grants are share-locked, in a fresh statement at the clock read
 * then. A grant revoked or expired while the lock waited covers nothing, and
 * a revocation after the second judgement waits for the caller's write.
 */
export async function lockCoveredCorrection(
  tx: TenantQuery,
  id: string,
  covering: Covering,
): Promise<StoredCorrection | undefined> {
  const parameters = [tx.businessId, ...coveringParameters(covering), id];
  const [row] = await tx.query<Row>(
    `${EFFECTIVE_AT}
     select ${COLUMNS} from public.live_corrections c
      where c.business_id = $1 and c.id = $6 and ${COVERED}
      for update of c`,
    parameters,
  );
  if (row === undefined) return undefined;
  await holdCoveringGrants(tx, covering);
  const still = await tx.query<{ readonly id: string }>(
    `${EFFECTIVE_AT}
     select c.id from public.live_corrections c
      where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    parameters,
  );
  return still.length === 0 ? undefined : correctionFrom(row);
}

/** Every correction the caller's run:write reaches (ORCH33), newest first, filtered in the query. */
export async function listCoveredCorrections(
  tx: TenantQuery,
  subjects: readonly Subject[],
): Promise<readonly StoredCorrection[]> {
  const rows = await tx.query<Row>(
    `${EFFECTIVE_AT}
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
