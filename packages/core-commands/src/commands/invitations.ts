// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: a team invitation's three acts, each a person's under `access:share`
// on the whole business (the permission key catalogue; the envelope asks it
// and audits the act in the same transaction). No agent reaches any of them.
//
// - `invitation.create` names a person, their address and a role. It writes a
//   new enduring person and the invitation, pending for the lifetime below.
// - `invitation.resend` moves a pending invitation's expiry on by a lifetime.
// - `invitation.revoke` ends a pending invitation.
//
// An administrator's invitation, created or resent, also asks `access:manage`
// on the whole business: an administrator manages access, so only a person
// who already may can make one, and `access:share` alone is refused
// `SCOPE_NOT_GRANTED`, writing nothing. A revoke asks `access:share` only.
//
// Each create and resend is one act the send may answer with one email
// (`core-custody/src/broker-invitation.ts`): the send counts these acts from
// the audit chain, so nothing here sends and nothing here holds a token.
//
// **Rate limits** (SP-14): at most `perAddressPerHour` acts on one address
// and `perAccountPerHour` by one person, counted from the applied audit events
// under the durable limiter's locks (`hasRoom`), so there is no counter to
// drift. A refused act is no act. Expiry is the business's worker's
// (`invitation-expiry.ts`).
//
// An address already pending, or confirmed on a member of this business, is
// refused: the inviter can see the team, so the answer tells them nothing new.

import { hasRoom, isUuid, type TenantQuery } from '../../../core-records/src/index.ts';
import { INVITATION_SEND_ACTS } from '../../../core-custody/src/index.ts';
import type { CommandContext } from './context.ts';
import type { CommandRequest } from './requests.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { expireDue } from './invitation-expiry.ts';
import { ADMIN_ROLE, noLongerHeld, notManager } from './invitation-authority.ts';

/** How long an invitation, and the link each send mints, stays good. */
export const INVITATION_LIFETIME_DAYS = 7;

/** The abuse limits, per hour (SP-14). */
export const INVITATION_LIMITS = { perAddressPerHour: 3, perAccountPerHour: 30 } as const;

/** The roles a team invitation may name. An owner is never invited. */
const ROLES: ReadonlySet<string> = new Set(['member', 'admin']);
const NAME_MAX = 200;
const ADDRESS_MAX = 254;
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

type Act = CommandRequest & {
  readonly command: 'invitation.create' | 'invitation.resend' | 'invitation.revoke';
};

const invalid = (name: string, fix: string): HandlerOutcome =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [name], [fix]));

const taken = (): HandlerOutcome =>
  refused(
    refuseCommand(
      'UNIQUE_VALUE_TAKEN',
      ['email'],
      ['This address already has a pending invitation or belongs to a member of this business.'],
    ),
  );

const limited = (name: 'email' | 'account'): HandlerOutcome =>
  refused(
    refuseCommand(
      'RATE_LIMITED',
      [name],
      [`Too many invitations for this ${name === 'email' ? 'address' : 'account'} this hour.`],
    ),
  );

const notPending = (): HandlerOutcome =>
  refused(
    refuseCommand(
      'TRANSITION_NOT_PERMITTED',
      ['state'],
      ['Only a pending invitation is resent or revoked. Invite again instead.'],
    ),
  );

/** The role an administrator's invitation names: it asks `access:manage` too. */
/** Applied acts in the last hour that one of the counts below selects. */
const ACTS_IN_HOUR = `a.business_id = $1 and a.outcome = 'applied' and a.command = any($2::text[])
   and a.occurred_at > now() - interval '1 hour'`;

async function count(tx: TenantQuery, sql: string, values: readonly unknown[]): Promise<number> {
  const [row] = await tx.query<{ n: number }>(sql, [
    tx.businessId,
    INVITATION_SEND_ACTS,
    ...values,
  ]);
  return row?.n ?? 0;
}

/** Room for one more act on this address and by this account; the locks hold to commit. */
async function overLimit(
  tx: TenantQuery,
  address: string,
  actorId: string,
): Promise<HandlerOutcome | undefined> {
  const onAddress = {
    name: `invitation:address:${address}`,
    limit: INVITATION_LIMITS.perAddressPerHour,
    count: async (q: TenantQuery) =>
      await count(
        q,
        `select count(*)::int as n from audit_events a
           join invitations i on i.business_id = a.business_id and i.id = a.subject_record_id
          where ${ACTS_IN_HOUR} and i.address = $3`,
        [address],
      ),
  };
  if (!(await hasRoom(tx, [onAddress]))) return limited('email');
  const byAccount = {
    name: `invitation:account:${actorId}`,
    limit: INVITATION_LIMITS.perAccountPerHour,
    count: async (q: TenantQuery) =>
      await count(
        q,
        `select count(*)::int as n from audit_events a where ${ACTS_IN_HOUR} and a.actor_id = $3`,
        [actorId],
      ),
  };
  return (await hasRoom(tx, [byAccount])) ? undefined : limited('account');
}

/** Pending, or confirmed on a person who is a member now. */
async function addressTaken(tx: TenantQuery, address: string): Promise<boolean> {
  const [row] = await tx.query<{ taken: boolean }>(
    `select exists (select 1 from invitations
                     where business_id = $1 and address = $2 and state = 'pending')
         or exists (select 1 from person_identifiers p
                      join memberships m on m.business_id = p.business_id
                                        and m.person_id = p.person_id and m.active
                     where p.business_id = $1 and p.kind = 'email' and p.value = $2
                       and p.review_state = 'confirmed') as taken`,
    [tx.businessId, address],
  );
  return row?.taken === true;
}

async function create(
  tx: TenantQuery,
  context: CommandContext,
  request: Act & { readonly command: 'invitation.create' },
): Promise<HandlerOutcome> {
  const name = request.name.trim();
  const address = request.email.trim().toLowerCase();
  if (name === '' || name.length > NAME_MAX) {
    return invalid('name', `Send the person's name, 1 to ${String(NAME_MAX)} characters.`);
  }
  if (address.length > ADDRESS_MAX || !ADDRESS.test(address)) {
    return invalid('email', 'Send one email address.');
  }
  if (!ROLES.has(request.role)) return invalid('role', 'Send member or admin.');
  const unmanaged = request.role === ADMIN_ROLE ? await notManager(tx, context) : undefined;
  if (unmanaged !== undefined) return unmanaged;
  const limit = await overLimit(tx, address, context.session.actorId);
  if (limit !== undefined) return limit;
  const gone = await noLongerHeld(tx, context, request.role);
  if (gone !== undefined) return gone;
  // A pending invitation whose lifetime has passed is expired first, by the worker.
  await expireDue(tx, address);
  if (await addressTaken(tx, address)) return taken();
  const [made] = await tx.query<{ id: string }>(
    `with person as (
       insert into people (business_id, id, display_name)
       values ($1, gen_random_uuid(), $2) returning id)
     insert into invitations
       (business_id, id, person_id, role_key, address, expires_at, created_by_actor_id)
     select $1, gen_random_uuid(), person.id, $3, $4,
            now() + make_interval(days => $5::int), $6
       from person
     returning id`,
    [tx.businessId, name, request.role, address, INVITATION_LIFETIME_DAYS, context.session.actorId],
  );
  const id = made?.id ?? '';
  return applied(id, 1, { invitationId: id, state: 'pending' });
}

interface Pending {
  readonly id: string;
  readonly address: string;
  readonly role_key: string;
  readonly state: string;
  readonly live: boolean;
}

/**
 * Whether the invitation is live now, on the clock: an act that waited for a lock is judged when
 * it got it, not when its transaction or the lock statement began.
 */
async function liveNow(tx: TenantQuery, id: string): Promise<boolean> {
  const [now] = await tx.query<{ live: boolean }>(
    `select expires_at > clock_timestamp() as live from invitations
      where business_id = $1 and id = $2`,
    [tx.businessId, id],
  );
  return now?.live === true;
}

/**
 * The invitation, locked; another business's and an unissued id are one answer. Whether it is
 * live is read by a second statement once the lock is held.
 */
async function locked(tx: TenantQuery, id: string): Promise<Pending | undefined> {
  if (!isUuid(id)) return undefined;
  const [row] = await tx.query<Omit<Pending, 'live'>>(
    `select id, address, role_key, state from invitations
      where business_id = $1 and id = $2 for update`,
    [tx.businessId, id],
  );
  if (row === undefined) return undefined;
  return { ...row, live: await liveNow(tx, id) };
}

async function move(
  tx: TenantQuery,
  context: CommandContext,
  request: Act & { readonly command: 'invitation.resend' | 'invitation.revoke' },
): Promise<HandlerOutcome> {
  const found = await locked(tx, request.invitationId);
  if (found === undefined) return refused(refuseNotFound(['invitationId']));
  if (found.state !== 'pending') return notPending();
  const resend = request.command === 'invitation.resend';
  if (resend) {
    if (!found.live) return notPending();
    const unmanaged = found.role_key === ADMIN_ROLE ? await notManager(tx, context) : undefined;
    if (unmanaged !== undefined) return unmanaged;
    const limit = await overLimit(tx, found.address, context.session.actorId);
    if (limit !== undefined) return limit;
    // The limit locks may have been waited on: judged again with every lock held.
    if (!(await liveNow(tx, found.id))) return notPending();
  }
  const gone = await noLongerHeld(tx, context, resend ? found.role_key : '');
  if (gone !== undefined) return gone;
  const [moved] = resend
    ? await tx.query<{ revision: number; state: string }>(
        `update invitations set expires_at = now() + make_interval(days => $3::int),
                revision = revision + 1
          where business_id = $1 and id = $2 returning revision, state`,
        [tx.businessId, found.id, INVITATION_LIFETIME_DAYS],
      )
    : await tx.query<{ revision: number; state: string }>(
        `update invitations set state = 'revoked', ended_at = now(), revision = revision + 1
          where business_id = $1 and id = $2 returning revision, state`,
        [tx.businessId, found.id],
      );
  return applied(found.id, moved?.revision ?? null, {
    invitationId: found.id,
    state: moved?.state,
  });
}

/** The one handler the three rows name. */
export async function invitationAct(
  tx: TenantQuery,
  context: CommandContext,
  request: Act,
): Promise<HandlerOutcome> {
  if (request.command === 'invitation.create') return await create(tx, context, request);
  return await move(tx, context, request);
}

export { expireInvitations } from './invitation-expiry.ts';
