// SPDX-License-Identifier: AGPL-3.0-only
//
// The effective-grant walk every grant check and reach read starts from, kept
// beside `grants.ts` (which re-exports it) so the checks there stay readable.
//
// The one expression of "live, and still covered by its granter", and the
// authority. A row written around `issueGrant` is judged by this and nothing
// else, which is what lets the issue-time check name a reason without being
// the barrier.
//
// The depth guard is not decoration. `parent_grant_id` sits under the same
// UPDATE privilege that writes `revoked_at`, so a cycle is reachable, and an
// unbounded recursive term that meets a cycle does not return.
//
// Expiry is judged when the statement runs, as a revocation is seen, not when
// the transaction began: a check that waited on a lock sees a grant that
// lapsed while it waited.
export const EFFECTIVE = `
  with recursive effective as (
    select g.*, 1 as depth
      from public.grants g
     where g.parent_grant_id is null
       and g.revoked_at is null
       and (g.expires_at is null or g.expires_at > statement_timestamp())
    union all
    select c.*, p.depth + 1
      from public.grants c
      join effective p on p.id = c.parent_grant_id
     where p.depth < 8
       and c.revoked_at is null
       and (c.expires_at is null or c.expires_at > statement_timestamp())
       and p.can_delegate
       and c.collection = p.collection
       and c.action = p.action
       and (p.scope_kind = 'business'
            or (c.scope_kind = p.scope_kind and c.scope_id is not distinct from p.scope_id))
       and (not c.can_delegate or p.may_permit_delegation)
       and not c.may_permit_delegation
       and (p.expires_at is null
            or (c.expires_at is not null and c.expires_at <= p.expires_at))
  )`;
