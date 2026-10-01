// SPDX-License-Identifier: AGPL-3.0-only
//
// A verified Send Email hook message from the login provider lands (C39-T,
// piece P2). System work, no person grant: the hook's signature is its
// authority. The provider sends no mail of its own; what it asks to be
// mailed reaches a person only through the broker's `email.send`, with its
// delivery attempt, or not at all.
//
// The message is looked for in each of the deployment's businesses in turn,
// every one of them whatever the message, so the work done never depends on
// who holds an account. In each, a message id already recorded as an
// attempt's `asked` evidence is a replay; else the address's pending
// invitation, if any, is noted.
//
// - An invitation is sent when exactly one business holds a pending
//   invitation for the address: through `sendInvitation`, with the
//   provider's token and the message id, so every check of a person's act
//   applies and the attempt carries the id. An address pending in two
//   businesses names neither, and nothing is sent.
// - Every other action (a reset, a magic link, an address change, a
//   reauthentication, a sign-up) has no delivery attempt to carry it yet,
//   so nothing is sent: no mail without its attempt (C40 brings the reset's).
//
// The answer is `SENT` or `NOT_SENT`, and the route answers both alike.

import type { AuthMessage } from '../../core-connectors/src/index.ts';
import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { sendInvitation } from './broker-invitation.ts';
import type { MailSettings } from './broker-email.ts';
import type { Broker } from './broker-types.ts';

export type AuthMessageOutcome = 'SENT' | 'NOT_SENT' | 'REPLAYED';

/** In one business: a replay, the address's pending invitation, or nothing. */
async function lookIn(
  tx: TenantQuery,
  message: AuthMessage & { readonly id: string },
): Promise<'REPLAYED' | string | undefined> {
  const [row] = await tx.query<{ replayed: boolean; invitation: string | null }>(
    `select exists (select 1 from public.invitation_delivery_attempts
                     where business_id = $1 and evidence = $2) as replayed,
            (select id from public.invitations
              where business_id = $1 and address = $3 and state = 'pending'
                and expires_at > now()) as invitation`,
    [tx.businessId, `hook:${message.id}`, message.address],
  );
  if (row?.replayed === true) return 'REPLAYED';
  return row?.invitation ?? undefined;
}

/** Hand one verified message to the broker's send, or send nothing. */
export async function deliverAuthMessage(
  database: Database,
  businesses: readonly BusinessId[],
  broker: Broker,
  mail: MailSettings,
  message: AuthMessage & { readonly id: string },
): Promise<AuthMessageOutcome> {
  const pending: { readonly business: BusinessId; readonly invitation: string }[] = [];
  for (const business of businesses) {
    // oxlint-disable-next-line no-await-in-loop -- one business at a time, every one of them
    const seen = await database.withBusiness(business, async (tx) => await lookIn(tx, message));
    if (seen === 'REPLAYED') return 'REPLAYED';
    if (seen !== undefined) pending.push({ business, invitation: seen });
  }
  const [only] = pending;
  if (message.action !== 'invite' || only === undefined || pending.length > 1) return 'NOT_SENT';
  const sent = await sendInvitation(database, only.business, only.invitation, broker, mail, {
    token: message.tokenHash,
    hookId: message.id,
  });
  if (!sent.ok && sent.code === 'REPLAYED') return 'REPLAYED';
  return sent.ok || 'attemptId' in sent ? 'SENT' : 'NOT_SENT';
}
