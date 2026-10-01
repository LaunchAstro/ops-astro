// SPDX-License-Identifier: AGPL-3.0-only
//
// What every broker email send shares (the inbox item's in `broker-email.ts`,
// C39-T's invitation in `broker-invitation.ts`): the sender check, the
// catalogued `email.send` and its route, and the one reading of what the
// provider answered, which the login provider's `auth.create_user` shares
// (`broker-auth-user.ts`). Nothing here sends or writes.

import type { ModelOperation, SenderReport } from '../../core-connectors/src/index.ts';
import type { BrokerRoute, Broker, ProviderAdapter } from './broker-types.ts';
import type { CustodyOutcome } from './custody.ts';
import { fromVerifiedSender, type DeliverRefusal } from './email-class.ts';

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

export interface Routed {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly adapter: ProviderAdapter;
}

/** A catalogued operation, its route and its adapter, or nothing when any is missing. */
export function routed(broker: Broker, key: string = EMAIL_OPERATION): Routed | undefined {
  const operation = broker.operations.get(key);
  if (operation === undefined) return undefined;
  const route = broker.routes.find((entry) => entry.provider === operation.provider);
  const adapter = broker.providers.get(operation.provider);
  return route === undefined || adapter === undefined ? undefined : { operation, route, adapter };
}

/** The route for one email from the verified sender only, or why there is none. */
export function sendRoute(
  broker: Broker,
  mail: { readonly from: string; readonly sender: SenderReport },
): Routed | DeliverRefusal {
  if (!fromVerifiedSender(mail.from, mail.sender)) return 'SENDER_NOT_VERIFIED';
  return routed(broker) ?? 'OPERATION_NOT_CATALOGUED';
}

/** What came back: the answer as its schema reads it, or the fault's kind. Never the body. */
export function answerOf(
  outcome: CustodyOutcome,
  operation: ModelOperation,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly fault: string } {
  if (outcome.kind === 'refused') return { ok: false, fault: 'refused' };
  if (outcome.kind === 'worker_lost') return { ok: false, fault: 'worker_lost' };
  if (!outcome.outbound.ok) return { ok: false, fault: outcome.outbound.fault };
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return { ok: false, fault: 'malformed' };
  }
  const answer = operation.answer(body);
  return answer === undefined ? { ok: false, fault: 'malformed' } : { ok: true, text: answer.text };
}

/** What came back: the provider's message id, or the fault's kind. Never the answer's body. */
export function observed(
  outcome: CustodyOutcome,
  operation: ModelOperation,
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  const answer = answerOf(outcome, operation);
  if (!answer.ok) return { state: 'failed', evidence: answer.fault };
  return { state: 'accepted', evidence: `provider:${answer.text}` };
}
