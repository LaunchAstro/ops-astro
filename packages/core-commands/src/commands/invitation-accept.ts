// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T, piece P3: `invitation accepted` and `login created (person,
// business)` on the one-time enrolment token alone: the token is the
// authority, and the writes are the business's worker's.
//
// 1. Find the token (`enrolment_token_find`, SEC27 F6), live (unspent, in its
//    lifetime, its pending invitation's newest), else `ENROLMENT_LINK_INVALID`.
// 2. Claim the invitation under its lock, every check again. A login bound
//    here under our id already: `sign_in`. A live claim, or no room under the
//    provider calls' limits: `ENROLMENT_UNAVAILABLE`, nothing asked.
// 3. Through custody, make the login under our id (`loginSubject`), or set
//    the address's login again under it, adopting one an earlier accept
//    stranded. No user under our id: someone else's login, untouched,
//    `sign_in`. A refused password is `PASSWORD_INVALID`; a fault binds
//    nothing. Either lets the claim go; a lost one lapses.
// 4. Under the lock and the claim, every check again: spend the tokens,
//    accept, seat the person, map the login, audit both events. An adopted
//    login's sessions all end (C40's reset window). No session opens.

import { createHash } from 'node:crypto';
import { payloadDigest } from '../../../core-digest/src/index.ts';
import {
  advisoryLock,
  openResetWindow,
  settleResetWindow,
  waitForNextSecond,
  type Database,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import {
  createLogin,
  loginLimits,
  updateLogin,
  type Broker,
  type LoginAsked,
  type LoginLimits,
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

const UNAVAILABLE = { ok: false, code: 'ENROLMENT_UNAVAILABLE' } as const;
const LINK_INVALID = { ok: false, code: 'ENROLMENT_LINK_INVALID' } as const;
const SIGN_IN = { ok: true, state: 'sign_in' } as const;

interface Found {
  readonly business: string;
  readonly tokenId: string;
  readonly invitationId: string;
  readonly personId: string;
  readonly roleKey: string;
  readonly address: string;
}

/**
 * Our provider user id for one address in one business, a UUID (v8, RFC 9562) from SHA-256: by
 * address, not person, so the next invitation for the address finds a login one stranded.
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

/** The invitation locked, with its address (and claim, when named); then its token live again. */
async function heldLive(tx: TenantQuery, asked: Found, claimId: string | null = null) {
  const held = await tx.query(
    `select 1 from invitations where business_id = $1 and id = $2 and address = $3
        and ($4::uuid is null or accept_claim = $4) for update`,
    [tx.businessId, asked.invitationId, asked.address, claimId],
  );
  const found = held.length === 1 ? await liveToken(tx, asked.tokenId) : undefined;
  return found?.invitationId === asked.invitationId ? found : undefined;
}

/** Step 2: the claim's id, or why none; one lock over every business's claims, for the limits. */
async function claim(tx: TenantQuery, asked: Found, subject: string, limits: LoginLimits) {
  if ((await heldLive(tx, asked)) === undefined) return 'invalid';
  const bound = await tx.query(
    'select 1 from logins where business_id = $1 and provider = $2 and subject = $3',
    [tx.businessId, LOGIN_PROVIDER, subject],
  );
  if (bound.length > 0) return 'bound';
  await advisoryLock(tx, 'enrolment_claims');
  const [taken] = await tx.query<{ id: string }>(
    `update invitations i set accept_claim = gen_random_uuid(),
            accept_claimed_until = clock_timestamp() + make_interval(secs => $5::float8 / 1000)
      where i.business_id = $1 and i.id = $2
        and coalesce(i.accept_claimed_until <= clock_timestamp(), true)
        and (select count(*) from invitations n where n.business_id = $1
               and n.accept_claimed_until > clock_timestamp()) < $3
        and public.enrolment_route_room($4) = 1
      returning accept_claim as id`,
    [tx.businessId, asked.invitationId, limits.concurrency, limits.ceiling, limits.boundMs],
  );
  return taken?.id ?? 'busy';
}

const RELEASE = `update invitations set accept_claim = null, accept_claimed_until = null
  where business_id = $1 and id = $2 and accept_claim = $3`;

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

/** Step 4: everything the acceptance changes, in one transaction; false when the link died. */
async function bind(
  tx: TenantQuery,
  asked: Found,
  { subject, claimId, adopted }: { subject: string; claimId: string; adopted: boolean },
): Promise<boolean> {
  const found = await heldLive(tx, asked, claimId);
  if (found === undefined) return false;
  const { invitationId, personId, tokenId } = found;
  await tx.query(
    `update enrolment_tokens set spent_at = now()
      where business_id = $1 and invitation_id = $2 and spent_at is null`,
    [tx.businessId, invitationId],
  );
  await tx.query(
    `update invitations set state = 'accepted', ended_at = now(), revision = revision + 1,
            accept_claim = null, accept_claimed_until = null
      where business_id = $1 and id = $2`,
    [tx.businessId, invitationId],
  );
  const worker = await workerActor(tx);
  const loginId = await seat(tx, found, subject, worker);
  if (adopted) {
    const window = await openResetWindow(tx, subject);
    await waitForNextSecond(tx);
    await settleResetWindow(tx, window);
  }
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
  if (found === undefined) return LINK_INVALID;
  const id = loginSubject(found.business, found.address);
  const limits = loginLimits(broker);
  if (limits === undefined) return UNAVAILABLE;
  const claimId = await database.withBusiness(found.business, (tx) => claim(tx, found, id, limits));
  if (claimId === 'invalid' || claimId === 'bound' || claimId === 'busy') {
    return { invalid: LINK_INVALID, bound: SIGN_IN, busy: UNAVAILABLE }[claimId];
  }
  const asked: LoginAsked = { id, email: found.address, password: request.password };
  let login = await createLogin(broker, asked);
  const adopted = !login.ok && login.kind === 'refused';
  if (adopted) login = await updateLogin(broker, asked);
  const made = login.ok ? { subject: login.subject, claimId, adopted } : undefined;
  const bound =
    made !== undefined &&
    (await database.withBusiness(found.business, (tx) => bind(tx, found, made)));
  if (!bound) {
    await database.withBusiness(found.business, (tx) =>
      tx.query(RELEASE, [tx.businessId, found.invitationId, claimId]),
    );
  }
  if (login.ok) return bound ? { ok: true, state: 'enrolled' } : LINK_INVALID;
  if (login.kind === 'password') return { ok: false, code: 'PASSWORD_INVALID' };
  return login.kind === 'refused' ? SIGN_IN : UNAVAILABLE;
}
