// SPDX-License-Identifier: AGPL-3.0-only
//
// A record share: one person, one record, read (minimum contract 3.1 and 3.4).
//
// "A grant with `scope_kind = record` is a share of one thing", and sharing an
// uncontained task further is "an explicit `scope_kind = record` grant naming
// that task. There is no other widening path." This is that path, and it is
// how R4 (8.1) comes to exist: a person of the business with no membership,
// whose whole standing is what was shared with them.
//
// Three decisions, each written where it is paid.
//
// **The sharer needs `share` on that record.** Not `read`: being able to see a
// task is not being able to show it to somebody else. The check runs through
// `checkAuthority` at record scope, so a business-wide `share` covers it and a
// share of a *different* record does not.
//
// **The grant is a root grant, granted by the sharer.** `grants.ts` chains a
// derived grant only under a parent of the same action, and a share is cut
// from `share`, not from `read`. So the row names the sharer as granter and
// carries no parent, which means revoking the sharer's own `share` does not
// collapse what they shared. Revocation of a share is `revokeShare`, and
// minimum contract 3.5 binds an external *assignment's* grant to the
// assignment, which is the gated path this file does not implement.
//
// **Read only.** R4 is "that task's shared fields and client-audience comments
// only". An external comment would need its audience forced to `client` by
// `task.comment` itself, which is not this module's to change, so a share that
// carried `comment` would let an outsider write a team note. It does not.

import type { TenantQuery } from '../tenancy/database.ts';
import { checkAuthority, issueGrant, revokeGrant, type Subject } from './grants.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Who is sharing: the person, and the actor the grant row names as granter. */
export interface Sharer {
  readonly personId: string;
  readonly actorId: string;
}

export interface ShareRequest {
  /** The record type's key, which is also the grant's collection (`task`). */
  readonly collection: string;
  readonly recordId: string;
  /** The person the record is shared with. */
  readonly personId: string;
}

export type ShareRefusalCode = 'SCOPE_NOT_GRANTED' | 'NOT_FOUND';

export interface ShareRefusal {
  readonly code: ShareRefusalCode;
  readonly reason: string;
  readonly fix: string;
}

export type ShareDecision<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: ShareRefusal };

const subjectsOfSharer = (sharer: Sharer): readonly Subject[] => [
  { kind: 'person', id: sharer.personId },
  { kind: 'actor', id: sharer.actorId },
];

/**
 * Share one record with one person, for reading.
 *
 * Idempotent: a live share of the same record with the same person is
 * returned rather than issued twice, so a repeated share leaves one row to
 * revoke. Authority is checked before existence, so a sharer with no `share`
 * learns nothing about whether the record or the person is there.
 */
export async function shareRecord(
  tx: TenantQuery,
  sharer: Sharer,
  request: ShareRequest,
): Promise<ShareDecision<string>> {
  const refused = await refuseShare(tx, sharer, request);
  if (refused !== undefined) return refused;

  const live = await liveShares(tx, request);
  if (live[0] !== undefined) return { ok: true, value: live[0] };

  const issued = await issueGrant(tx, [], {
    subject: { kind: 'person', id: request.personId },
    scope: { kind: 'record', id: request.recordId },
    collection: request.collection,
    action: 'read',
    parentGrantId: null,
    grantedByActorId: sharer.actorId,
  });
  if (!issued.ok) throw new Error(`shareRecord: a root grant was refused ${issued.refusal.code}`);
  return { ok: true, value: issued.value };
}

/** Withdraw every live share of this record with this person. Returns how many. */
export async function revokeShare(
  tx: TenantQuery,
  sharer: Sharer,
  request: ShareRequest,
): Promise<ShareDecision<number>> {
  const refused = await refuseShare(tx, sharer, request);
  if (refused !== undefined) return refused;
  const live = await liveShares(tx, request);
  for (const grantId of live) {
    // One transaction, one connection: sequential because they share it.
    // oxlint-disable-next-line no-await-in-loop
    await revokeGrant(tx, grantId);
  }
  return { ok: true, value: live.length };
}

async function refuseShare(
  tx: TenantQuery,
  sharer: Sharer,
  request: ShareRequest,
): Promise<ShareDecision<never> | undefined> {
  if (!UUID.test(request.recordId) || !UUID.test(request.personId)) return notFound();
  const authorised = await checkAuthority(tx, subjectsOfSharer(sharer), {
    collection: request.collection,
    action: 'share',
    scope: { kind: 'record', id: request.recordId },
  });
  if (!authorised.ok) {
    return {
      ok: false,
      refusal: {
        code: 'SCOPE_NOT_GRANTED',
        reason: authorised.refusal.reason,
        fix: authorised.refusal.fix,
      },
    };
  }
  const found = await tx.query<{ readonly record: boolean; readonly person: boolean }>(
    `select exists (select 1 from public.records r
                      join public.record_types t
                        on t.business_id = r.business_id and t.id = r.record_type_id
                     where r.business_id = $1 and r.id = $2 and t.key = $3
                       and r.deleted_at is null) as record,
            exists (select 1 from public.people p
                     where p.business_id = $1 and p.id = $4) as person`,
    [tx.businessId, request.recordId, request.collection, request.personId],
  );
  if (found[0]?.record !== true || found[0]?.person !== true) return notFound();
  return undefined;
}

async function liveShares(tx: TenantQuery, request: ShareRequest): Promise<readonly string[]> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.grants
      where business_id = $1 and subject_kind = 'person' and subject_id = $2
        and scope_kind = 'record' and scope_id = $3 and collection = $4 and action = 'read'
        and revoked_at is null and (expires_at is null or expires_at > now())
      order by granted_at`,
    [tx.businessId, request.personId, request.recordId, request.collection],
  );
  return rows.map((row) => row.id);
}

function notFound(): ShareDecision<never> {
  return {
    ok: false,
    refusal: {
      code: 'NOT_FOUND',
      reason: 'no such record or person here',
      fix: 'check the identifiers',
    },
  };
}
