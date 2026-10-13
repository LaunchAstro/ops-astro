// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: `invitation accepted` and `login created (person, business)` on the
// one-time enrolment token alone. No sign-in exists yet: the token is the
// authority, and the writes are the system's, as the effect of the inviter's
// `access:share` act.
//
// 1. Find the token: its SHA-256, looked up by `enrolment_token_find`, which
//    answers only for a hash exactly one business holds.
// 2. In that business, in one transaction, take the locks in the one order
//    every invitation writer takes them: the access lock shared, the
//    invitation's row, the token's row. Then, after the last wait and on the
//    clock:
//    - the token is unspent, inside its lifetime and its invitation's, and the
//      invitation's newest;
//    - the invitation is pending;
//    - its inviter still holds `access:share`, and `access:manage` for an
//      administrator's;
//    - the first-client gate is open for an act that gives someone access,
//      the invitation class, which fails closed.
//    Anything else is one answer and writes nothing.
// 3. Spend the token, by its own predicate again, accept the invitation and
//    seat the invited person: their acting identity, their address confirmed,
//    a login under a new id of ours, its mapping and a membership in the
//    invited role. No grant: an administrator grants on the Access screen. The
//    login is owed to the provider: one `login_provisions` row, which the M5
//    unit settles by making the provider's login under that id and mailing a
//    link to set its password. Both acts are audited, as the business's worker.
//
// Nothing asks for or takes a password, and nothing answered holds the token.

import { createHash, randomUUID } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import {
  checkAuthority,
  lockAccess,
  type BusinessId,
  type Database,
  type Subject,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { DataEffects } from '../../../core-wire/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { workerActor } from './conversation-lifecycle.ts';
import { effectsGate } from './first-client-gate.ts';

export const ACCEPT_OPERATION = 'invitation.accept';
export const LOGIN_CREATE_OPERATION = 'login.create';

/** The provider the `logins` rows name for Supabase Auth (`apps/api/auth/supabase.ts`). */
const LOGIN_PROVIDER = 'supabase';

/** The token a send mints: 32 random bytes, base64url, 43 characters. */
const TOKEN = /^[\w-]{43}$/u;

/** A business id no business has, for the one lookup that runs before any business is known. */
const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';

export type AcceptCode = 'ENROLMENT_LINK_INVALID' | 'ENROLMENT_NOT_YET';
export type AcceptResult =
  { readonly ok: true } | { readonly ok: false; readonly code: AcceptCode };

const INVALID = { ok: false, code: 'ENROLMENT_LINK_INVALID' } as const;

/** What an accept does to the business: it gives an outsider access, the gate's invitation class. */
const ADMITS: DataEffects = {
  writes: ['people', 'actors', 'logins', 'memberships', 'invitations'].map((kind) => ({
    kind,
    scope: 'business' as const,
  })),
  intake: [],
  outside: [],
  access: true,
};
const NOT_YET = { ok: false, code: 'ENROLMENT_NOT_YET' } as const;

interface Found {
  readonly business: BusinessId;
  readonly invitation: string;
  readonly token: string;
}

interface Held {
  readonly personId: string;
  readonly roleKey: string;
  readonly address: string;
  readonly inviter: string;
}

/** Step 1: the one business holding this hash, and its ids. */
async function find(database: Database, hash: string): Promise<Found | undefined> {
  const [at] = await database.withBusiness(
    NO_BUSINESS,
    async (tx) =>
      await tx.query<{ business: string | null; invitation: string | null; token: string | null }>(
        `select business_id as business, invitation_id as invitation, token_id as token
           from public.enrolment_token_find($1)`,
        [hash],
      ),
  );
  if (!at?.business || !at.invitation || !at.token) return undefined;
  return { business: at.business, invitation: at.invitation, token: at.token };
}

/** Step 2: the locks in order, then everything judged live on the clock, after the last wait. */
async function heldLive(tx: TenantQuery, found: Found): Promise<Held | undefined> {
  await lockAccess(tx, 'shared');
  const [invitation] = await tx.query<{ id: string }>(
    'select id from invitations where business_id = $1 and id = $2 for update',
    [tx.businessId, found.invitation],
  );
  const [token] = await tx.query<{ id: string }>(
    `select id from enrolment_tokens
      where business_id = $1 and id = $2 and invitation_id = $3 for update`,
    [tx.businessId, found.token, found.invitation],
  );
  if (invitation === undefined || token === undefined) return undefined;
  const [live] = await tx.query<{
    person_id: string;
    role_key: string;
    address: string;
    inviter: string;
  }>(
    `select i.person_id, i.role_key, i.address, i.created_by_actor_id as inviter
       from invitations i
       join enrolment_tokens t on t.business_id = i.business_id and t.invitation_id = i.id
      where i.business_id = $1 and i.id = $2 and t.id = $3
        and i.state = 'pending' and i.expires_at > clock_timestamp()
        and t.spent_at is null and t.expires_at > clock_timestamp()
        and not exists (
          select 1 from enrolment_tokens n
           where n.business_id = t.business_id and n.invitation_id = t.invitation_id
             and (n.created_at, n.id) > (t.created_at, t.id))`,
    [tx.businessId, found.invitation, found.token],
  );
  if (live === undefined) return undefined;
  return {
    personId: live.person_id,
    roleKey: live.role_key,
    address: live.address,
    inviter: live.inviter,
  };
}

/** Whether the inviter still holds what the invitation asked of them, under the access lock. */
async function inviterHolds(tx: TenantQuery, held: Held): Promise<boolean> {
  const [actor] = await tx.query<{ person_id: string | null }>(
    `select person_id from actors
      where business_id = $1 and id = $2 and kind = 'person' and active`,
    [tx.businessId, held.inviter],
  );
  if (actor?.person_id === null || actor?.person_id === undefined) return false;
  const subjects: readonly Subject[] = [
    { kind: 'person', id: actor.person_id },
    { kind: 'actor', id: held.inviter },
  ];
  const holds = async (action: 'share' | 'manage'): Promise<boolean> =>
    (
      await checkAuthority(tx, subjects, {
        collection: 'access',
        action,
        scope: { kind: 'business', id: null },
      })
    ).ok;
  if (!(await holds('share'))) return false;
  return held.roleKey !== 'admin' || (await holds('manage'));
}

/** Owe the new login to the provider and audit the accept and the login. */
async function oweAndAudit(
  tx: TenantQuery,
  found: Found,
  held: Held,
  loginId: string,
): Promise<void> {
  const { businessId } = tx;
  await tx.query(
    `insert into login_provisions (business_id, id, invitation_id, login_id)
     values ($1, gen_random_uuid(), $2, $3)`,
    [businessId, found.invitation, loginId],
  );
  const worker = await workerActor(tx);
  await writeAuditEvent(tx, {
    actorId: worker,
    command: ACCEPT_OPERATION,
    operationId: `${ACCEPT_OPERATION}:${found.invitation}`,
    outcome: 'applied',
    subjectRecordId: found.invitation,
    payloadDigest: payloadDigest({ invitationId: found.invitation }),
  });
  await writeAuditEvent(tx, {
    actorId: worker,
    command: LOGIN_CREATE_OPERATION,
    operationId: `${LOGIN_CREATE_OPERATION}:${loginId}`,
    outcome: 'applied',
    subjectRecordId: loginId,
    payloadDigest: payloadDigest({ loginId, personId: held.personId }),
  });
}

/** Step 3: spend, accept, seat, owe the login, audit; `false` when the spend found nothing. */
async function seat(tx: TenantQuery, found: Found, held: Held): Promise<boolean> {
  const { businessId } = tx;
  const spent = await tx.query<{ id: string }>(
    `update enrolment_tokens set spent_at = clock_timestamp()
      where business_id = $1 and id = $2 and spent_at is null and expires_at > clock_timestamp()
      returning id`,
    [businessId, found.token],
  );
  if (spent.length !== 1) return false;
  await tx.query(
    `update invitations set state = 'accepted', ended_at = clock_timestamp(), revision = revision + 1
      where business_id = $1 and id = $2 and state = 'pending'`,
    [businessId, found.invitation],
  );
  const [actorId, loginId] = [randomUUID(), randomUUID()];
  await tx.query(
    `insert into actors (business_id, id, kind, person_id, active)
     values ($1, $2, 'person', $3, true)`,
    [businessId, actorId, held.personId],
  );
  await tx.query(
    `insert into person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, source_id,
        review_state)
     values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'invitation', $4, 'confirmed')
     on conflict (business_id, person_id, kind, value)
       do update set review_state = 'confirmed', last_observed_at = now()`,
    [businessId, held.personId, held.address, found.invitation],
  );
  await tx.query(
    'insert into logins (business_id, id, provider, subject) values ($1, $2, $3, $4)',
    [businessId, loginId, LOGIN_PROVIDER, randomUUID()],
  );
  await tx.query(
    `insert into person_logins (business_id, id, login_id, person_id, active, linked_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3, true, $4)`,
    [businessId, loginId, held.personId, held.inviter],
  );
  await tx.query(
    `insert into memberships (business_id, id, person_id, role_key, active)
     values ($1, gen_random_uuid(), $2, $3, true)`,
    [businessId, held.personId, held.roleKey],
  );
  await oweAndAudit(tx, found, held, loginId);
  return true;
}

/** Accept the invitation whose link carried `token`, or refuse with one answer, writing nothing. */
export async function acceptInvitation(database: Database, token: string): Promise<AcceptResult> {
  if (!TOKEN.test(token)) return INVALID;
  const hash = createHash('sha256').update(token).digest('hex');
  const found = await find(database, hash);
  if (found === undefined) return INVALID;
  return await database.withBusiness(found.business, async (tx) => {
    const held = await heldLive(tx, found);
    if (held === undefined || !(await inviterHolds(tx, held))) return INVALID;
    if ((await effectsGate(tx, ADMITS)) !== undefined) return NOT_YET;
    return (await seat(tx, found, held)) ? ({ ok: true } as const) : INVALID;
  });
}
