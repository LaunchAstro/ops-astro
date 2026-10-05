// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)`, on the one-time enrolment token alone. No one is signed in yet,
// so no person's grant is asked: the token is the authority, and the writes
// are the system's, as the business's worker, under that token.
//
// 1. Find the token. A hash is unique in its business only, and the accept
//    arrives with none, so its SHA-256 is looked up once, by one narrow
//    security definer function that answers the business, the invitation and
//    the token ids, and only for a hash exactly one business holds (SEC27 F6,
//    `enrolment_token_find`). The token is then read in its own business: it
//    is live only while it is unspent (a resend or a revoke spends every token
//    before it, SEC27 F5), inside its lifetime, the newest its invitation has,
//    and its invitation is pending and inside its own lifetime. Every other
//    token, an unknown one among them, is one answer: `ENROLMENT_LINK_INVALID`.
// 2. Make the login at the login provider, through custody, for the invited
//    address, with the password the page set and the address confirmed,
//    under a provider user id that is ours: the same every time for one
//    address in one business (`loginSubject`). A login this business has
//    bound under that id already is never set again: the answer is
//    `sign_in`. Otherwise it is made (`auth.create_user`); when the address
//    already holds a login, that login is set again under our id
//    (`auth.update_user`), which adopts one an earlier accept made and never
//    bound (its answer came too late, or its link died before the bind),
//    with the password set now. When there is no user under our id, the
//    address's login is someone else's (another business's, or made
//    elsewhere): it gets none and its password is not touched, the answer is
//    `sign_in`, and nothing is spent, so its holder may accept once signed in
//    (that binding is a follow-up). A password the provider's rules refuse
//    is `PASSWORD_INVALID`, nothing made or set. A fault spends nothing and
//    binds nothing; a login it stranded is adopted by the next accept.
// 3. In one transaction, under the invitation's lock and every check again,
//    on the clock once the lock is held (pending, the token unspent and
//    newest, this business, and the address the login was made for, SEC27 F5): spend every unspent token of the invitation, mark it accepted, give its
//    one enduring person an acting identity, a membership in the invited
//    role and the confirmed address, map the new login to that person, and
//    write both audit events. The link then does nothing, and nothing here
//    opens a session: the person signs in with the login, as anyone does.

import { createHash } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import type { Database, TenantQuery } from '../../../core-records/src/index.ts';
import {
  createLogin,
  updateLogin,
  type Broker,
  type LoginAsked,
} from '../../../core-custody/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { workerActor } from './conversation-lifecycle.ts';

export const ACCEPT_OPERATION = 'invitation.accept';
export const LOGIN_CREATE_OPERATION = 'login.create';

/** The provider the `logins` rows name for Supabase Auth (`apps/api/auth/supabase.ts`). */
const LOGIN_PROVIDER = 'supabase';

/** A password the provider will hash in full: 12 to 72 bytes (bcrypt reads no more). */
const PASSWORD_BYTES = { least: 12, most: 72 } as const;

/** The token a send mints: 32 random bytes, base64url, 43 characters. */
const TOKEN = /^[\w-]{43}$/u;

export interface AcceptRequest {
  readonly token: string;
  readonly password: string;
}

export type AcceptResult =
  | { readonly ok: true; readonly state: 'enrolled' | 'sign_in' }
  | {
      readonly ok: false;
      readonly code: 'ENROLMENT_LINK_INVALID' | 'PASSWORD_INVALID' | 'ENROLMENT_UNAVAILABLE';
    };

interface Found {
  readonly business: string;
  readonly tokenId: string;
  readonly invitationId: string;
  readonly personId: string;
  readonly roleKey: string;
  readonly address: string;
}

/**
 * The provider user id for one address in one business: a UUID (version 8,
 * RFC 9562) from SHA-256 of a fixed label, the business and the address. The
 * address, not the person: each invitation makes a new person, and a login an
 * earlier invitation stranded must be found by the next one for the address.
 */
function loginSubject(business: string, address: string): string {
  const hex = createHash('sha256').update(`ops-astro login|${business}|${address}`).digest('hex');
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Whether this business has bound a login under the subject already. */
async function loginBound(database: Database, business: string, subject: string): Promise<boolean> {
  return await database.withBusiness(business, async (tx) => {
    const rows = await tx.query(
      'select 1 from logins where business_id = $1 and provider = $2 and subject = $3',
      [tx.businessId, LOGIN_PROVIDER, subject],
    );
    return rows.length > 0;
  });
}

/** A business-less transaction's business: the lookup below reads no tenant's rows. */
const NO_BUSINESS = '00000000-0000-0000-0000-000000000000';

/** The token's row and its invitation, when the token is live. */
async function liveToken(
  tx: TenantQuery,
  tokenId: string,
): Promise<Omit<Found, 'business'> | undefined> {
  const [row] = await tx.query<Omit<Found, 'business'> & { live: boolean }>(
    `select t.id as "tokenId", i.id as "invitationId", i.person_id as "personId",
            i.role_key as "roleKey", i.address,
            (t.spent_at is null and t.expires_at > clock_timestamp()
              and i.state = 'pending' and i.expires_at > clock_timestamp()
              and not exists (select 1 from enrolment_tokens n
                               where n.business_id = t.business_id
                                 and n.invitation_id = t.invitation_id
                                 and n.created_at > t.created_at)) as live
       from enrolment_tokens t
       join invitations i on i.business_id = t.business_id and i.id = t.invitation_id
      where t.business_id = $1 and t.id = $2`,
    [tx.businessId, tokenId],
  );
  if (row?.live !== true) return undefined;
  const { live: _live, ...found } = row;
  return found;
}

/** Step 1: the one business whose live token this is, among the deployment's, or none. */
async function find(
  database: Database,
  businesses: readonly string[],
  hash: string,
): Promise<Found | undefined> {
  const [at] = await database.withBusiness(
    NO_BUSINESS,
    async (tx) =>
      await tx.query<{ business: string | null; token: string }>(
        'select business_id as business, token_id as token from public.enrolment_token_find($1)',
        [hash],
      ),
  );
  if (at?.business === null || at === undefined || !businesses.includes(at.business)) {
    return undefined;
  }
  const { business, token } = at;
  const row = await database.withBusiness(business, async (tx) => await liveToken(tx, token));
  return row === undefined ? undefined : { business, ...row };
}

/** The invitation's person seated: an actor, a membership, the address, and the login mapped. */
async function seat(
  tx: TenantQuery,
  found: Omit<Found, 'business'>,
  subject: string,
  worker: string,
): Promise<string | null> {
  await tx.query(
    `with actor as (
       insert into actors (business_id, id, kind, person_id)
       values ($1, gen_random_uuid(), 'person', $2)),
     membership as (
       insert into memberships (business_id, id, person_id, role_key)
       values ($1, gen_random_uuid(), $2, $3))
     insert into person_identifiers
       (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
     values ($1, gen_random_uuid(), $2, 'email', $4, $4, 'invitation', 'confirmed')`,
    [tx.businessId, found.personId, found.roleKey, found.address],
  );
  // The login first, then its mapping: the mapping's trigger locks the login row.
  const [login] = await tx.query<{ id: string }>(
    `insert into logins (business_id, id, provider, subject)
     values ($1, gen_random_uuid(), $2, $3) returning id`,
    [tx.businessId, LOGIN_PROVIDER, subject],
  );
  await tx.query(
    `insert into person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3, $4)`,
    [tx.businessId, login?.id, found.personId, worker],
  );
  return login?.id ?? null;
}

/** Step 3: everything the acceptance changes, in one transaction; false when the link died. */
async function bind(tx: TenantQuery, asked: Found, subject: string): Promise<boolean> {
  // The invitation's lock first, held to commit, with the address the login was made for; then
  // every check again in a statement of its own, so a resend or revoke committed meanwhile shows.
  const held = await tx.query(
    `select 1 from invitations where business_id = $1 and id = $2 and address = $3 for update`,
    [tx.businessId, asked.invitationId, asked.address],
  );
  const found = held.length === 1 ? await liveToken(tx, asked.tokenId) : undefined;
  if (found?.invitationId !== asked.invitationId) return false;
  const { invitationId, personId, tokenId } = found;
  await tx.query(
    `update enrolment_tokens set spent_at = now()
      where business_id = $1 and invitation_id = $2 and spent_at is null`,
    [tx.businessId, invitationId],
  );
  await tx.query(
    `update invitations set state = 'accepted', ended_at = now(), revision = revision + 1
      where business_id = $1 and id = $2`,
    [tx.businessId, invitationId],
  );
  const worker = await workerActor(tx);
  const loginId = await seat(tx, found, subject, worker);
  const event = { actorId: worker, outcome: 'applied' } as const;
  await writeAuditEvent(tx, {
    ...event,
    command: ACCEPT_OPERATION,
    operationId: `${ACCEPT_OPERATION}:${tokenId}`,
    subjectRecordId: invitationId,
    payloadDigest: payloadDigest({ invitationId, personId }),
  });
  await writeAuditEvent(tx, {
    ...event,
    command: LOGIN_CREATE_OPERATION,
    operationId: `${LOGIN_CREATE_OPERATION}:${tokenId}`,
    subjectRecordId: loginId,
    payloadDigest: payloadDigest({ personId, loginId, businessId: tx.businessId }),
  });
  return true;
}

/** Accept the invitation a one-time enrolment token names, with the password its holder set. */
export async function acceptInvitation(
  database: Database,
  businesses: readonly string[],
  broker: Broker,
  request: AcceptRequest,
): Promise<AcceptResult> {
  const bytes = Buffer.byteLength(request.password, 'utf8');
  if (bytes < PASSWORD_BYTES.least || bytes > PASSWORD_BYTES.most) {
    return { ok: false, code: 'PASSWORD_INVALID' };
  }
  const hash = createHash('sha256').update(request.token).digest('hex');
  const found = TOKEN.test(request.token) ? await find(database, businesses, hash) : undefined;
  if (found === undefined) return { ok: false, code: 'ENROLMENT_LINK_INVALID' };
  const id = loginSubject(found.business, found.address);
  if (await loginBound(database, found.business, id)) return { ok: true, state: 'sign_in' };
  const asked: LoginAsked = { id, email: found.address, password: request.password };
  let login = await createLogin(broker, asked);
  if (!login.ok && login.kind === 'refused') login = await updateLogin(broker, asked);
  if (!login.ok && login.kind === 'password') return { ok: false, code: 'PASSWORD_INVALID' };
  if (!login.ok) {
    return login.kind === 'refused'
      ? { ok: true, state: 'sign_in' }
      : { ok: false, code: 'ENROLMENT_UNAVAILABLE' };
  }
  const bound = await database.withBusiness(
    found.business,
    async (tx) => await bind(tx, found, login.subject),
  );
  return bound ? { ok: true, state: 'enrolled' } : { ok: false, code: 'ENROLMENT_LINK_INVALID' };
}
