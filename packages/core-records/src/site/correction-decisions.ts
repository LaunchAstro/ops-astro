// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's decision read over `live_corrections` (0311): one correction's state,
// who decided it and its version, filtered by the caller's grant at the
// correction's own party inside the query, as every read in
// `live-corrections.ts` is. And the approval's two reads of who may decide:
// the configured approver and their membership.

import { EFFECTIVE } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import {
  APPROVER_SETTING,
  COVERED,
  coveringParameters,
  type CorrectionState,
  type Covering,
} from './live-corrections.ts';

/** What a card reads again of one correction: its state, who decided it, its version. */
export interface CorrectionDecision {
  readonly correctionId: string;
  readonly state: CorrectionState;
  /** The deciding person's display name; null until decided. */
  readonly approver: string | null;
  readonly versionId: string;
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
    readonly version_id: string;
  }>(
    `${EFFECTIVE}
     select c.id, c.state, p.display_name as approver, c.version_id
       from public.live_corrections c
       left join public.people p
         on p.business_id = c.business_id and p.id = c.decided_by_person_id
      where c.business_id = $1 and c.id = $6 and ${COVERED}`,
    [tx.businessId, ...coveringParameters(covering), id],
  );
  const [row] = rows;
  return row === undefined
    ? undefined
    : { correctionId: row.id, state: row.state, approver: row.approver, versionId: row.version_id };
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

/** Whether a person is an active member of this business (an approver must be). */
export async function isActiveMember(tx: TenantQuery, personId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly present: boolean }>(
    `select true as present from public.memberships
      where business_id = $1 and person_id = $2 and active and ended_at is null`,
    [tx.businessId, personId],
  );
  return rows.length > 0;
}
