// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)`, on the one-time enrolment token alone. No one is signed in yet,
// so no person's grant is asked: the token is the authority, and the writes
// are the system's, as the business's worker, under that token.
//
// 1. Find the token. Its SHA-256 is looked for in every one of the
//    deployment's businesses, each under its own tenancy, whatever the token,
//    so the work done never depends on which business holds it. It is live
//    only while it is unspent, inside its lifetime, the newest its invitation
//    has (a resend's link replaces the one before), and its invitation is
//    pending and inside its own lifetime. Every other token, an unknown one
//    among them, is one answer: `ENROLMENT_LINK_INVALID`.
// 2. Make the login at the login provider, through custody, for the invited
//    address, with the password the page set and the address confirmed,
//    under a provider user id that is ours: the same every time for one
//    address in one business (`loginSubject`). A login any business has
//    bound under that id already (a signed-in accept binds one in another
//    business, `invitation-bind.ts`) answers `sign_in` and asks the provider
//    nothing. Otherwise it is made (`auth.create_user`), outside any lock:
//    a create makes a new user or is refused, and never changes one the
//    provider holds. Refused, the address holds a login already, whoever
//    made it: the answer is `sign_in`, nothing is set and nothing spent, and
//    its holder accepts once signed in (`acceptSignedIn`). That is how a
//    login an earlier accept made and never bound (its answer came too late,
//    or its link died before the bind) is recovered: the provider made it
//    with its holder's password and the address confirmed. No login is ever
//    set again here, so no accept can change the password of a login
//    another bound. A fault spends nothing and binds nothing.
// 3. In one transaction, for the login this accept made: the login id's
//    lock (`lockLoginId`), then the invitation's row lock, every check
//    again and whether this business has bound a login under the id now (a
//    signed-in accept with the new login may have). Then spend every unspent
//    token of the invitation, mark it accepted, give its one enduring person
//    an acting identity, a membership in the invited role and the confirmed
//    address, map the new login to that person, and write both audit
//    events. The link then does nothing, and nothing here opens a session:
//    the person signs in with the login, as anyone does. The lock order is
//    the login id's key, then the invitation's row; revoke, resend, send and
//    the expiry never take the login id's key.

import { createHash } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import { advisoryLock, type Database, type TenantQuery } from '../../../core-records/src/index.ts';
import { createLogin, type Broker } from '../../../core-custody/src/index.ts';
import { writeAuditEvent } from './audit.ts';
import { boundHere, LOGIN_PROVIDER, loginBound, loginSubject } from './invitation-login.ts';
import { workerActor } from './conversation-lifecycle.ts';

export { LOGIN_PROVIDER, loginSubject } from './invitation-login.ts';

export const ACCEPT_OPERATION = 'invitation.accept';
export const LOGIN_CREATE_OPERATION = 'login.create';

/** A password the provider will hash in full: 12 to 72 bytes (bcrypt reads no more). */
const PASSWORD_BYTES = { least: 12, most: 72 } as const;

/** The token a send mints: 32 random bytes, base64url, 43 characters. */
export const TOKEN: RegExp = /^[\w-]{43}$/u;

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

export interface Found {
  readonly business: string;
  readonly tokenId: string;
  readonly invitationId: string;
  readonly personId: string;
  readonly roleKey: string;
  readonly address: string;
}

/**
 * Lock one provider login id, whichever business made or binds it. Every
 * accept that could set or bind the login takes it before any row lock: the
 * token-only accept on its own id for the address, the signed-in accept on
 * that id and on the session's login. The key names the login id alone, so
 * the two flows in two businesses serialise on the one string.
 */
export async function lockLogin(tx: TenantQuery, id: string): Promise<void> {
  await advisoryLock(tx, `c39-t-login:${id}`);
}

/**
 * Lock the login id for one address in the transaction's business, and
 * return it. Taken before the invitation's row by every accept for the
 * address, so the check that this business binds no login under the id and
 * the bind run for one accept at a time.
 */
export async function lockLoginId(tx: TenantQuery, address: string): Promise<string> {
  const id = loginSubject(tx.businessId, address);
  await lockLogin(tx, id);
  return id;
}

/** The token's row and its invitation, when the token is live; locked when `lock`. */
export async function liveToken(
  tx: TenantQuery,
  hash: string,
  lock: boolean,
): Promise<Omit<Found, 'business'> | undefined> {
  const [row] = await tx.query<Omit<Found, 'business'> & { live: boolean }>(
    `select t.id as "tokenId", i.id as "invitationId", i.person_id as "personId",
            i.role_key as "roleKey", i.address,
            (t.spent_at is null and t.expires_at > now()
              and i.state = 'pending' and i.expires_at > now()
              and not exists (select 1 from enrolment_tokens n
                               where n.business_id = t.business_id
                                 and n.invitation_id = t.invitation_id
                                 and n.created_at > t.created_at)) as live
       from enrolment_tokens t
       join invitations i on i.business_id = t.business_id and i.id = t.invitation_id
      where t.business_id = $1 and t.token_hash = $2
      ${lock ? 'for update of i' : ''}`,
    [tx.businessId, hash],
  );
  if (row?.live !== true) return undefined;
  const { live: _live, ...found } = row;
  return found;
}

/** Step 1: the one business whose live token this is, or none. */
export async function find(
  database: Database,
  businesses: readonly string[],
  hash: string,
): Promise<Found | undefined> {
  const found: Found[] = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const row = await database.withBusiness(
      business,
      async (tx) => await liveToken(tx, hash, false),
    );
    if (row !== undefined) found.push({ business, ...row });
  }
  return found.length === 1 ? found[0] : undefined;
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
  // A signed-in accept may find this business's row for the login unmapped: it is kept.
  const [login] = await tx.query<{ id: string }>(
    `with made as (
       insert into logins (business_id, id, provider, subject)
       values ($1, gen_random_uuid(), $2, $3)
       on conflict (business_id, provider, subject) do nothing returning id)
     select id from made
     union all
     select id from logins where business_id = $1 and provider = $2 and subject = $3`,
    [tx.businessId, LOGIN_PROVIDER, subject],
  );
  await tx.query(
    `insert into person_logins (business_id, id, login_id, person_id, linked_by_actor_id)
     values ($1, gen_random_uuid(), $2, $3, $4)`,
    [tx.businessId, login?.id, found.personId, worker],
  );
  return login?.id ?? null;
}

/** Everything the acceptance changes, under the locks the caller took: a live, locked invitation. */
export async function spendAndSeat(
  tx: TenantQuery,
  found: Omit<Found, 'business'>,
  subject: string,
): Promise<void> {
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
}

const SIGN_IN = { ok: true, state: 'sign_in' } as const;

/** Step 3, under the locks: the bind of the login this accept made. */
async function enrol(tx: TenantQuery, hash: string, address: string): Promise<AcceptResult> {
  const id = await lockLoginId(tx, address);
  const found = await liveToken(tx, hash, true);
  if (found === undefined) return { ok: false, code: 'ENROLMENT_LINK_INVALID' };
  if (await boundHere(tx, id)) return SIGN_IN;
  await spendAndSeat(tx, found, id);
  return { ok: true, state: 'enrolled' };
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
  if (await loginBound(database, businesses, id)) return SIGN_IN;
  const made = await createLogin(broker, { id, email: found.address, password: request.password });
  if (!made.ok) {
    return made.kind === 'refused' ? SIGN_IN : { ok: false, code: 'ENROLMENT_UNAVAILABLE' };
  }
  const { address } = found;
  return await database.withBusiness(found.business, async (tx) => await enrol(tx, hash, address));
}
