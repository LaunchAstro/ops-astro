// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's decision read over `live_corrections` (0311): one correction's state,
// who decided it and its version, filtered by the caller's grant at the
// correction's own party inside the query, as every read in
// `live-corrections.ts` is. And the approval's two reads of who may decide:
// the configured approver and their membership.

import { EFFECTIVE } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, type Covering } from './covering.ts';
import {
  APPROVER_SETTING,
  COLUMNS,
  pinnedFrom,
  type CorrectionState,
  type LiveCorrection,
  type Row,
} from './live-corrections.ts';

/** The window in which the runner's last check of the page vouches for the version (#1693). */
export const VERIFIED_FOR_MS = 60_000;

/** What a card reads again of one correction: its state, who decided it, its version. */
export interface CorrectionDecision {
  readonly correctionId: string;
  readonly state: CorrectionState;
  /** The deciding person's display name; null until decided. */
  readonly approver: string | null;
  /** Null until the runner pins the version (`locating`, `unlocated`, an unpinned `cancelled`). */
  readonly versionId: string | null;
  readonly verifiedAt: string | null;
  /** How much longer the last check vouches, by the server's clock in this read; 0 for none. */
  readonly verifiedForMs: number;
  /** The fixed locate code of an `unlocated` or `superseded` correction, else null. */
  readonly refusal: string | null;
}

/**
 * One correction's decision, when the caller's grant covers it at its party,
 * or undefined: absent, in another business or not covered are one answer.
 * Unlocked: it reads, and decides nothing.
 */
export async function readCoveredDecision(
  tx: TenantQuery,
  id: string,
  covering: Covering,
): Promise<CorrectionDecision | undefined> {
  const rows = await tx.query<{
    readonly id: string;
    readonly state: CorrectionState;
    readonly approver: string | null;
    readonly version_id: string | null;
    readonly verified_at: Date | null;
    readonly verified_for_ms: number;
    readonly locate_code: string | null;
  }>(
    `${EFFECTIVE_AT}
     select c.id, c.state, p.display_name as approver, c.version_id, c.verified_at,
            c.locate_code,
            greatest(0, ${VERIFIED_FOR_MS} - coalesce(floor(extract(epoch from
              clock_timestamp() - c.verified_at) * 1000), ${VERIFIED_FOR_MS}))::int
              as verified_for_ms
       from public.live_corrections c
       left join public.people p
         on p.business_id = c.business_id and p.id = c.decided_by_person_id
      where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), id],
  );
  const [row] = rows;
  return row === undefined
    ? undefined
    : {
        correctionId: row.id,
        state: row.state,
        approver: row.approver,
        versionId: row.version_id,
        verifiedAt: row.verified_at === null ? null : row.verified_at.toISOString(),
        // Only a `requested` correction's check vouches for anything a person may launch.
        verifiedForMs: row.state === 'requested' ? row.verified_for_ms : 0,
        refusal: row.locate_code,
      };
}

/**
 * Whether the caller holds the pair at any scope at all. A caller holding
 * none is refused rather than told an id names nothing; the answer does not
 * depend on any id, so it confirms none.
 */
export async function holdsAnywhere(tx: TenantQuery, covering: Covering): Promise<boolean> {
  const rows = await tx.query<{ readonly held: boolean }>(
    `${EFFECTIVE}
     select exists (
       select 1 from effective e
        where e.collection = $1 and e.action = $2
          and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                       where s.kind = e.subject_kind and s.id = e.subject_id)) as held`,
    coveringParameters(covering),
  );
  return rows[0]?.held === true;
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

/** How long the runner's last check of the page vouches for the version (#1693, register 65). */
const FRESH = `c.verified_at >= clock_timestamp() - interval '60 seconds'`;

/**
 * Whether the runner checked the locked row's page within the window, by the clock read in this
 * statement: the caller holds the row's lock, so the time is read after its wait.
 */
export async function isVerifiedNow(tx: TenantQuery, id: string): Promise<boolean> {
  const rows = await tx.query<{ readonly fresh: boolean }>(
    `select coalesce(${FRESH}, false) as fresh from public.live_corrections c
      where c.business_id = $1 and c.id = $2`,
    [tx.businessId, id],
  );
  return rows[0]?.fresh === true;
}

/**
 * Write the decision on a row the caller has already locked and judged. The
 * decision records the version digest of the version the approver named. An
 * approval lands only while the runner's last check is within the window, by
 * the clock read in this statement after every wait the decision took: that
 * statement is where the approval is decided (#1693). Undefined: it is not.
 */
export async function writeCorrectionDecision(
  tx: TenantQuery,
  write: DecisionWrite,
): Promise<LiveCorrection | undefined> {
  const rows = await tx.query<Row>(
    `update public.live_corrections as c
        set state = $3, decided_by_actor_id = $4, decided_by_person_id = $5,
            decided_at = now(), decided_version_digest = c.version_digest,
            revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'requested'
        and ($3 = 'rejected' or ${FRESH})
      returning ${COLUMNS}`,
    [tx.businessId, write.id, write.decision, write.actorId, write.personId],
  );
  const [row] = rows;
  return row === undefined ? undefined : pinnedFrom(row);
}
