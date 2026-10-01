// SPDX-License-Identifier: AGPL-3.0-only
//
// C39-T: an invitation's email, through the broker's catalogued `email.send`
// and custody only, as AW-07b sends an inbox item's.
//
// 1. Check, in the invitation's business: the operation is catalogued and
//    routed, the invitation is pending and inside its lifetime, and it has an
//    act no send has answered yet. The acts are `invitation.create` and
//    `invitation.resend` as the audit chain holds them applied, so a row no
//    person's act made, or a refused act, sends nothing; each act sends once.
//    Then a fresh enrolment token is minted and kept as its SHA-256 alone,
//    and the attempt is recorded `asked` against it. A refusal writes nothing.
// 2. Send, through custody, the adapter's message: the address the invitation
//    names and one link, the enrolment page carrying the token.
// 3. Record what came back as the attempt's next observation, read as the
//    inbox send reads it. Nothing returned or written holds the token.
//
// The concurrency ceiling is the catalogued one, counted over invitation
// attempts in flight under a lock of their own.

import { createHash, randomBytes } from 'node:crypto';
import {
  hasRoom,
  isUuid,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation } from '../../core-connectors/src/index.ts';
import { observed, routed } from './broker-email-route.ts';
import type { MailSettings } from './broker-email.ts';
import type { Broker } from './broker-types.ts';

/** The acts an invitation's send answers, one email each. */
export const INVITATION_SEND_ACTS: readonly string[] = ['invitation.create', 'invitation.resend'];

/** Where the link lands: the enrolment page, with the token as its last segment. */
export const ENROL_PATH = '/enrol/';

export type InvitationSendRefusal =
  'OPERATION_NOT_CATALOGUED' | 'INVITATION_NOT_PENDING' | 'NO_SEND_ACT' | 'EMAIL_AT_CEILING';

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
}

async function inFlight(tx: TenantQuery): Promise<number> {
  const [row] = await tx.query<{ n: number }>(
    `select count(*)::int as n from (
       select distinct on (token_id) state from invitation_delivery_attempts
        where business_id = $1 order by token_id, observed_seq desc) last
      where state = 'asked'`,
    [tx.businessId],
  );
  return row?.n ?? 0;
}

async function recordAttempt(
  tx: TenantQuery,
  asked: Pick<Asked, 'invitationId' | 'tokenId'>,
  seen: { readonly state: string; readonly evidence?: string },
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into invitation_delivery_attempts
       (business_id, id, invitation_id, token_id, state, evidence)
     values ($1, gen_random_uuid(), $2, $3, $4, $5) returning id`,
    [tx.businessId, asked.invitationId, asked.tokenId, seen.state, seen.evidence ?? null],
  );
  return row?.id ?? '';
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
      where business_id = $1 and id = $2 and state = 'pending' and expires_at > now()
      for update`,
    [tx.businessId, invitationId],
  );
  if (invitation === undefined) return 'INVITATION_NOT_PENDING';
  const [tally] = await tx.query<{ acts: number; sends: number }>(
    `select (select count(*) from audit_events
              where business_id = $1 and subject_record_id = $2 and outcome = 'applied'
                and command = any($3::text[]))::int as acts,
            (select count(*) from enrolment_tokens
              where business_id = $1 and invitation_id = $2)::int as sends`,
    [tx.businessId, invitationId, INVITATION_SEND_ACTS],
  );
  if ((tally?.sends ?? 0) >= (tally?.acts ?? 0)) return 'NO_SEND_ACT';
  const limit = { name: `invitation-email:${operation.key}`, limit: operation.concurrency };
  if (!(await hasRoom(tx, [{ ...limit, count: inFlight }]))) return 'EMAIL_AT_CEILING';
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
  const asked = { invitationId, tokenId: minted?.id ?? '', to: invitation.address, token };
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
  const found = routed(broker);
  if (found === undefined) return { ok: false, code: 'OPERATION_NOT_CATALOGUED' };
  const { operation, route, adapter } = found;
  const asked = await database.withBusiness(
    businessId,
    async (tx) => await ask(tx, invitationId, operation),
  );
  if (typeof asked === 'string') return { ok: false, code: asked };
  const link = new URL(`${ENROL_PATH}${asked.token}`, mail.appOrigin).href;
  const built = adapter.build({ to: asked.to, from: mail.from, address: link });
  const outcome = await broker.custody.dispatch(route.credentialRef, {
    destination: operation.destination,
    path: built.path,
    method: built.method,
    body: built.body,
    timeoutMs: operation.timeoutMs,
    maxResponseBytes: operation.maxResponseBytes,
  });
  const seen = observed(outcome, operation);
  const attemptId = await database.withBusiness(
    businessId,
    async (tx) => await recordAttempt(tx, asked, seen),
  );
  if (seen.state === 'accepted') return { ok: true, attemptId, state: 'accepted' };
  return { ok: false, code: 'EMAIL_FAILED', attemptId, fault: seen.evidence };
}
