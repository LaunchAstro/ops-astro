// SPDX-License-Identifier: AGPL-3.0-only
//
// Login resolution: verified subject to session, inside one transaction.
//
// The steps are the contract's (minimum contract, section 1.3). Step 1,
// verifying the credential with the auth provider, is not here: the provider
// question is open, and what arrives is a subject someone else has verified.
// Steps 2 to 4 are the query below. Step 5 is `withBusiness`, which is T1a's,
// and step 6 — deriving scope — is T1c's and happens in the same transaction
// this one opens, which is what makes "re-evaluated on each call" mechanical
// rather than a discipline.
//
// Two decisions worth seeing before the code.
//
// **The business is named, never discovered.** A caller says which business it
// is acting in and the server verifies it against the mapping. Resolving the
// business from the subject alone would mean reading `logins` across tenants,
// and the only way to do that under forced row security is a definer-rights
// function — a hole in the barrier, cut before anything in this part needs it.
// The contract permits the convenience; it does not require it, and the sign-in
// surface that wants it can arrive with its own proof.
//
// **A subject with no login row here is refused exactly as an unmapped one
// is.** Telling the two apart tells the caller whether that subject exists in
// this business, which is the same inference leak that makes a wrong-business
// read return NOT_FOUND. One refusal, one message, one shape.

import type { BusinessId, Database, TenantQuery } from '../tenancy/database.ts';
import { refuse, type Refusal } from './refusals.ts';
import { recordAuthenticationAttempt } from './authentication-attempts.ts';
import type { VerifiedSubject } from './verified-subject.ts';

export type { VerifiedSubject } from './verified-subject.ts';

/** What a resolved call runs as. The business is the server's value, not the caller's. */
export interface Session {
  readonly businessId: string;
  readonly loginId: string;
  readonly personId: string;
  readonly actorId: string;
  /**
   * The membership's role key, or null for an external party: a mapped person
   * with no membership whose whole standing is the record- or party-scoped
   * grants they hold (minimum contract 8.1, R4). Null rather than a word, so
   * no role a preset names can be mistaken for one.
   */
  readonly roleKey: string | null;
}

interface ResolutionRow {
  readonly login_id: string;
  readonly person_id: string | null;
  readonly membership_id: string | null;
  readonly role_key: string | null;
  readonly actor_id: string | null;
}

const NO_MEMBERSHIP_FIXES = [
  'ask an administrator of this business to link this login to a person',
  'check that the business named in the request is the intended one',
] as const;

const INACTIVE_FIXES = ['ask an administrator of this business to reactivate this person'] as const;

// Left joins rather than four round trips, because the four facts are read
// under one snapshot and one policy evaluation. Row security scopes every
// table to the business the wrapper set, so no clause below names it; the
// joins still carry business_id because a join that only works because a
// policy is in place is a join that stops working the day one is not.
const RESOLUTION = `
  select l.id as login_id,
         pl.person_id,
         m.id as membership_id,
         m.role_key,
         a.id as actor_id
    from public.logins l
    left join public.person_logins pl
      on pl.business_id = l.business_id and pl.login_id = l.id and pl.active
    left join public.memberships m
      on m.business_id = pl.business_id and m.person_id = pl.person_id and m.active
    left join public.actors a
      on a.business_id = pl.business_id and a.person_id = pl.person_id
     and a.kind = 'person' and a.active
   where l.provider = $1 and l.subject = $2`;

/**
 * Steps 2 to 4, inside an open transaction whose business is already set.
 *
 * Order matters and is the contract's: membership before actor. A login with
 * no active mapping, or a mapping to a person who is no longer a member, is
 * `AUTH_NO_MEMBERSHIP` — a refusal, not an empty projection. The one mapped
 * non-member who is not refused there is an external party standing on a live
 * share and holding no business grant, whose `roleKey` is null. A person with
 * standing but no active acting identity is `ACTOR_INACTIVE`, which says more
 * only because that standing has already been established.
 */
export async function resolveLogin(
  tx: TenantQuery,
  presented: VerifiedSubject,
): Promise<Session | Refusal> {
  const rows = await tx.query<ResolutionRow>(RESOLUTION, [presented.provider, presented.subject]);
  const found = rows[0];

  if (found === undefined || found.person_id === null) {
    return await recordRefusal(tx, presented, refuse('AUTH_NO_MEMBERSHIP', NO_MEMBERSHIP_FIXES));
  }
  if (found.membership_id === null && !(await standsOnShares(tx, found.person_id))) {
    return await recordRefusal(tx, presented, refuse('AUTH_NO_MEMBERSHIP', NO_MEMBERSHIP_FIXES));
  }
  if (found.actor_id === null) {
    return await recordRefusal(tx, presented, refuse('ACTOR_INACTIVE', INACTIVE_FIXES));
  }

  const session: Session = {
    businessId: tx.businessId,
    loginId: found.login_id,
    personId: found.person_id,
    actorId: found.actor_id,
    roleKey: found.role_key,
  };
  // The attempt and what it resolved to commit together with whatever the
  // caller goes on to do. I13 asks for every attempt, which includes the ones
  // that succeeded and the ones whose transaction later rolled back — those
  // roll back with it, and a recorded attempt for work that never happened
  // would be the worse trail.
  await recordAuthenticationAttempt(tx, {
    owner: 'person_login',
    presented,
    outcome: 'resolved',
    loginId: session.loginId,
    actorId: session.actorId,
    personId: session.personId,
  });
  return session;
}

// An external party's standing, read under the same snapshot as the mapping.
// A live share is a record- or party-scoped *read* grant to the person or to
// their acting identity, which is what `shareRecord` issues and all R4 reaches.
// A scoped `comment` or `write` grant is not a share and stands for nothing
// here, so a row a share would never carry cannot turn a non-member into a
// session (Sol 6 AUTHORITY-2). A live *business* grant disqualifies rather than helps: it
// is a member's grant, and a person holding one without a membership is a
// former member whose grants outlived them, who stays refused here exactly as
// before. The per-call check in the serving transaction still decides what the
// share reaches; this only decides whether there is anyone to ask about.
const STANDING = `
  select count(*) filter (where g.scope_kind <> 'business' and g.action = 'read')::int as shares,
         count(*) filter (where g.scope_kind = 'business')::int as business
    from public.grants g
    left join public.actors a
      on a.business_id = g.business_id and a.id = g.subject_id and a.kind = 'person'
   where g.revoked_at is null
     and (g.expires_at is null or g.expires_at > now())
     and ((g.subject_kind = 'person' and g.subject_id = $1)
          or (g.subject_kind = 'actor' and a.person_id = $1))`;

async function standsOnShares(tx: TenantQuery, personId: string): Promise<boolean> {
  const rows = await tx.query<{ readonly shares: number; readonly business: number }>(STANDING, [
    personId,
  ]);
  const row = rows[0];
  return row !== undefined && row.shares > 0 && row.business === 0;
}

/** A refusal and its record commit together, so nobody is turned away unrecorded. */
async function recordRefusal(
  tx: TenantQuery,
  presented: VerifiedSubject,
  refusal: Refusal,
): Promise<Refusal> {
  await recordAuthenticationAttempt(tx, {
    owner: 'person_login',
    presented,
    outcome: 'refused',
    refusalCode: refusal.code,
  });
  return refusal;
}

/**
 * The whole of steps 2 to 6 for one call: open the transaction, set the
 * business inside it, resolve, and only then run the work.
 *
 * The body is not called on a refusal, so there is no path on which a caller
 * does business inside a transaction whose actor was never established. That
 * is why this exists rather than a `resolve()` a caller is trusted to check.
 */
export async function withSession<T>(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  run: (tx: TenantQuery, session: Session) => Promise<T>,
): Promise<T | Refusal> {
  return await database.withBusiness(businessId, async (tx) => {
    const resolved = await resolveLogin(tx, presented);
    if ('refused' in resolved) return resolved;
    return await run(tx, resolved);
  });
}
