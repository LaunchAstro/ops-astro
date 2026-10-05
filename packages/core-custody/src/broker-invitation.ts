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
//    Then a fresh enrolment token is minted and kept as its SHA-256 alone,
//    and the attempt is recorded `asked` against it. A refusal writes nothing.
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

import { createHash, randomBytes } from 'node:crypto';
import {
  isUuid,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import { observed, sendRoute } from './broker-email-route.ts';
import type { MailSettings } from './broker-email.ts';
import type { Broker } from './broker-types.ts';
import { lapsed, readClocks, roomFor, type DeliverRefusal, type Reading } from './email-class.ts';
import { isLoopbackMock } from './email-mock-custody.ts';

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
  DeliverRefusal | 'INVITATION_NOT_PENDING' | 'NO_SEND_ACT' | 'EMAIL_AT_CEILING';

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
  seen: { readonly state: string; readonly evidence?: string },
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
 * lock the send waits on (the invitation's row, then the email limit): a send that waited is
 * judged when it got the lock, never when its transaction began, and never by a lock statement's
 * own reading taken before the wait.
 */
async function liveNow(tx: TenantQuery, invitationId: string): Promise<boolean> {
  const [row] = await tx.query<{ live: boolean }>(
    `select expires_at > clock_timestamp() as live from invitations
      where business_id = $1 and id = $2`,
    [tx.businessId, invitationId],
  );
  return row?.live === true;
}

/** Step 1: every check, the token's hash and the `asked` observation. */
async function ask(
  tx: TenantQuery,
  invitationId: string,
  operation: ModelOperation,
): Promise<Asked | InvitationSendRefusal> {
  if (!isUuid(invitationId)) return 'INVITATION_NOT_PENDING';
  const [invitation] = await tx.query<{ address: string; expires_at: Date }>(
    `select address, expires_at from invitations
      where business_id = $1 and id = $2 and state = 'pending' for update`,
    [tx.businessId, invitationId],
  );
  if (invitation === undefined || !(await liveNow(tx, invitationId))) {
    return 'INVITATION_NOT_PENDING';
  }
  const [tally] = await tx.query<{ acts: number; sends: number }>(
    `select (select count(*) from audit_events
              where business_id = $1 and subject_record_id = $2 and outcome = 'applied'
                and command = any($3::text[]))::int as acts,
            (select count(*) from enrolment_tokens
              where business_id = $1 and invitation_id = $2)::int as sends`,
    [tx.businessId, invitationId, INVITATION_SEND_ACTS],
  );
  if ((tally?.sends ?? 0) >= (tally?.acts ?? 0)) return 'NO_SEND_ACT';
  if (!(await roomFor(tx, operation)())) return 'EMAIL_AT_CEILING';
  if (!(await liveNow(tx, invitationId))) return 'INVITATION_NOT_PENDING';
  const token = randomBytes(32).toString('base64url');
  const [minted] = await tx.query<{ id: string }>(
    `insert into enrolment_tokens (business_id, id, invitation_id, token_hash, expires_at)
     values ($1, gen_random_uuid(), $2, $3, $4) returning id`,
    [
      tx.businessId,
      invitationId,
      createHash('sha256').update(token).digest('hex'),
      invitation.expires_at,
    ],
  );
  const reserved = readClocks();
  const asked = {
    invitationId,
    tokenId: minted?.id ?? '',
    to: invitation.address,
    token,
    reserved,
  };
  await recordAttempt(tx, asked, { state: 'asked' });
  return asked;
}

/** Email an invitation's link after an act that asked for it, through the broker only. */
export async function sendInvitation(
  database: Database,
  businessId: BusinessId,
  invitationId: string,
  broker: Broker,
  mail: MailSettings,
): Promise<InvitationSendResult> {
  const found = sendRoute(broker, mail);
  if (typeof found === 'string') return { ok: false, code: found };
  const { operation, route, adapter } = found;
  const asked = await database.withBusiness(
    businessId,
    async (tx) => await ask(tx, invitationId, operation),
  );
  if (typeof asked === 'string') return { ok: false, code: asked };
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
        isLoopbackMock(broker.custody) ? 'mock' : 'provider',
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
