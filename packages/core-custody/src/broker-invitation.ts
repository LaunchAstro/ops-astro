// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: an invitation's email, through the broker's catalogued `email.send`
// and custody only, as AW-07b sends an inbox item's.
//
// 1. Check, in the invitation's business: the mail is from the verified
//    sending subdomain, the operation is catalogued and routed, the
//    invitation is pending and inside its lifetime, and it has an act no
//    send has answered yet. The acts are `invitation.create` and
//    `invitation.resend` as the audit chain holds them applied, so a row no
//    person's act made, or a refused act, sends nothing; each act sends once.
//    Then a token is minted, 32 random bytes of our own, and kept as its
//    SHA-256 alone, and, with room under `email.send`'s one ceiling, the
//    attempt is recorded `asked` against it. A refusal writes nothing.
// 2. Send, through custody, the adapter's message: the address the invitation
//    names and one link, the enrolment page carrying the token. A sender that
//    paused past the fence since its ask (`lapsed`) calls nothing and records
//    `failed`, evidence `expired`, as the inbox send does.
// 3. Record what came back as the attempt's next observation, read as the
//    inbox send reads it; an answer holding anything token-shaped is
//    malformed. Nothing returned or written holds a token.
//
// The concurrency ceiling is the catalogued one, and the inbox send's own
// (`roomFor`): one limit, under one lock, counts every email in flight
// against the provider, inbox and invitation alike, each ask only until
// custody's timeout and the grace have passed.
//
// The login provider is never asked: nothing it issues is a secret of ours,
// and an address that already holds a login elsewhere is invited exactly as
// a new one is. When the provider's Send Email hook asks for an invitation
// (`broker-auth-email.ts`), the send is this same one, its tokens unread, and
// the hook message's id is the `asked` evidence, so a replayed message is
// refused under the invitation's lock. Once every check has passed, the send
// also claims the message id installation-wide, before its token: a second
// send of one message, from any business or hook process, finds the claim
// and is refused, writing nothing. A claim that waited on another send's is
// judged against the invitation's lifetime again once held.

import { createHash, randomBytes } from 'node:crypto';
import {
  isUuid,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import { observed, sendRoute, type Routed } from './broker-email-route.ts';
import type { MailSettings } from './broker-email.ts';
import type { Broker } from './broker-types.ts';
import { lapsed, readClocks, roomFor, type DeliverRefusal, type Reading } from './email-class.ts';

/** The acts an invitation's send answers, one email each. */
export const INVITATION_SEND_ACTS: readonly string[] = ['invitation.create', 'invitation.resend'];

/** Where the link lands: the enrolment page, with the token as its last segment. */
export const ENROL_PATH = '/enrol/';

/**
 * A run of base64url as long as an enrolment token (32 random bytes, 43 characters): evidence
 * holding one may hold a live link, whichever send or business minted it.
 */
const TOKEN_SHAPED = /[\w-]{43}/u;

export type InvitationSendRefusal =
  DeliverRefusal | 'INVITATION_NOT_PENDING' | 'NO_SEND_ACT' | 'EMAIL_AT_CEILING' | 'REPLAYED';

export type InvitationSendResult =
  | { readonly ok: true; readonly attemptId: string; readonly state: 'accepted' }
  | { readonly ok: false; readonly code: InvitationSendRefusal }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_FAILED';
      readonly attemptId: string;
      readonly fault: string;
    };

interface Asked {
  readonly invitationId: string;
  readonly tokenId: string;
  readonly to: string;
  readonly token: string;
  /** The host's clocks just before the `asked` attempt was written: the fence counts from here. */
  readonly reserved: Reading;
}

/**
 * One observation, stamped when it is written (`clock_timestamp()`), not when its transaction
 * began: an `asked` counts toward the ceiling from its reservation, however long the send waited
 * on the invitation's lock before it, as `recordAsked` stamps an inbox ask.
 */
async function recordAttempt(
  tx: TenantQuery,
  asked: Pick<Asked, 'invitationId' | 'tokenId'>,
  seen: { readonly state: string; readonly evidence?: string | null },
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into invitation_delivery_attempts
       (business_id, id, invitation_id, token_id, state, evidence, observed_at)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, clock_timestamp()) returning id`,
    [tx.businessId, asked.invitationId, asked.tokenId, seen.state, seen.evidence ?? null],
  );
  return row?.id ?? '';
}

/**
 * Whether the invitation's lifetime is still running, judged by a statement of its own after each
 * lock the send waits on (the invitation's row, the email limit, then a hook message's claim): a
 * send that waited is judged when it got the lock, never when its transaction began, and never by
 * a lock statement's own reading taken before the wait.
 */
async function liveNow(tx: TenantQuery, invitationId: string): Promise<boolean> {
  const [row] = await tx.query<{ live: boolean }>(
    `select expires_at > clock_timestamp() as live from invitations
      where business_id = $1 and id = $2`,
    [tx.businessId, invitationId],
  );
  return row?.live === true;
}

/** The act checks under the invitation's lock: its address, or why nothing may send. */
async function pendingAct(
  tx: TenantQuery,
  invitationId: string,
  hookId: string | undefined,
): Promise<{ readonly address: string; readonly expires: Date } | InvitationSendRefusal> {
  if (!isUuid(invitationId)) return 'INVITATION_NOT_PENDING';
  const [invitation] = await tx.query<{ address: string; expires_at: Date }>(
    `select address, expires_at from invitations
      where business_id = $1 and id = $2 and state = 'pending' for update`,
    [tx.businessId, invitationId],
  );
  if (invitation === undefined || !(await liveNow(tx, invitationId))) {
    return 'INVITATION_NOT_PENDING';
  }
  const [tally] = await tx.query<{ acts: number; sends: number; replayed: boolean }>(
    `select (select count(*) from audit_events
              where business_id = $1 and subject_record_id = $2 and outcome = 'applied'
                and command = any($3::text[]))::int as acts,
            (select count(*) from enrolment_tokens
              where business_id = $1 and invitation_id = $2)::int as sends,
            exists (select 1 from invitation_delivery_attempts
                     where business_id = $1 and evidence = $4) as replayed`,
    [tx.businessId, invitationId, INVITATION_SEND_ACTS, `hook:${hookId ?? ''}`],
  );
  if (hookId !== undefined && tally?.replayed === true) return 'REPLAYED';
  if ((tally?.sends ?? 0) >= (tally?.acts ?? 0)) return 'NO_SEND_ACT';
  return { address: invitation.address, expires: invitation.expires_at };
}

/**
 * The hook message's one claim, installation-wide (20261005140704), taken last, after every other
 * check. A claim another transaction has not committed yet is waited on: refused if that one
 * commits, `REPLAYED`. If it rolls back, this send holds the claim, but the wait may have outlived
 * the invitation, so its lifetime is judged again once the claim is held. A lapsed invitation
 * takes the claim back with its savepoint and answers as every other expiry here does, so the
 * refusal writes nothing, the claim included.
 */
async function claimHookMessage(
  tx: TenantQuery,
  invitationId: string,
  hookId: string,
): Promise<InvitationSendRefusal | undefined> {
  await tx.query('savepoint hook_message_claim');
  const claimed = await tx.query(
    `insert into ops.auth_hook_messages (message_digest) values ($1)
     on conflict (message_digest) do nothing returning 1`,
    [createHash('sha256').update(hookId).digest('hex')],
  );
  if (claimed.length === 1 && (await liveNow(tx, invitationId))) {
    await tx.query('release savepoint hook_message_claim');
    return undefined;
  }
  await tx.query('rollback to savepoint hook_message_claim');
  return claimed.length === 1 ? 'INVITATION_NOT_PENDING' : 'REPLAYED';
}

/** Step 1: every check, the hook message's claim, the minted token's hash and the `asked` observation. */
async function ask(
  tx: TenantQuery,
  invitationId: string,
  operation: ModelOperation,
  hookId: string | undefined,
): Promise<Asked | InvitationSendRefusal> {
  const act = await pendingAct(tx, invitationId, hookId);
  if (typeof act === 'string') return act;
  if (!(await roomFor(tx, operation)())) return 'EMAIL_AT_CEILING';
  if (!(await liveNow(tx, invitationId))) return 'INVITATION_NOT_PENDING';
  const unclaimed =
    hookId === undefined ? undefined : await claimHookMessage(tx, invitationId, hookId);
  if (unclaimed !== undefined) return unclaimed;
  const token = randomBytes(32).toString('base64url');
  const [minted] = await tx.query<{ id: string }>(
    `insert into enrolment_tokens (business_id, id, invitation_id, token_hash, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $4) returning id`,
    [tx.businessId, invitationId, createHash('sha256').update(token).digest('hex'), act.expires],
  );
  const reserved = readClocks();
  const asked = { invitationId, tokenId: minted?.id ?? '', to: act.address, token, reserved };
  const evidence = hookId === undefined ? null : `hook:${hookId}`;
  await recordAttempt(tx, asked, { state: 'asked', evidence });
  return asked;
}

/** Steps 2 and 3: the message through custody, and what came back as the next observation. */
async function deliver(
  database: Database,
  businessId: BusinessId,
  broker: Broker,
  { operation, route, adapter }: Routed,
  sent: { readonly mail: MailSettings; readonly asked: Asked },
): Promise<InvitationSendResult> {
  const { mail, asked } = sent;
  const link = new URL(`${ENROL_PATH}${asked.token}`, mail.appOrigin).href;
  const built = adapter.build({ to: asked.to, from: mail.from, address: link });
  const read = lapsed(asked.reserved)
    ? ({ state: 'failed', evidence: 'expired' } as const)
    : observed(
        await broker.custody.dispatch(route.credentialRef, {
          destination: operation.destination,
          path: built.path,
          method: built.method,
          body: built.body,
          timeoutMs: operation.timeoutMs,
          maxResponseBytes: operation.maxResponseBytes,
        }),
        operation,
      );
  // An answer is evidence about the message, never a place a link's token is kept: this
  // send's, an earlier send's or any other business's, all of one shape.
  const seen = TOKEN_SHAPED.test(read.evidence)
    ? ({ state: 'failed', evidence: 'malformed' } as const)
    : read;
  const attemptId = await database.withBusiness(
    businessId,
    async (tx) => await recordAttempt(tx, asked, seen),
  );
  if (seen.state === 'accepted') return { ok: true, attemptId, state: 'accepted' };
  return { ok: false, code: 'EMAIL_FAILED', attemptId, fault: seen.evidence };
}

/**
 * Email an invitation's link after an act that asked for it, through the
 * broker only. `hookId` is the id of the login provider's hook message that
 * asked for it, when one did.
 */
export async function sendInvitation(
  database: Database,
  businessId: BusinessId,
  invitationId: string,
  broker: Broker,
  mail: MailSettings,
  hookId?: string,
): Promise<InvitationSendResult> {
  const found = sendRoute(broker, mail);
  if (typeof found === 'string') return { ok: false, code: found };
  const asked = await database.withBusiness(
    businessId,
    async (tx) => await ask(tx, invitationId, found.operation, hookId),
  );
  if (typeof asked === 'string') return { ok: false, code: asked };
  return await deliver(database, businessId, broker, found, { mail, asked });
}
