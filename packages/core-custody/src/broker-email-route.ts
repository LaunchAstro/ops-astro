// SPDX-License-Identifier: AGPL-3.0-only
//
// What every broker email send shares (the inbox item's in `broker-email.ts`,
// C39-T's invitation in `broker-invitation.ts`): the sender check, the
// catalogued `email.send` and its route, and the one reading of what the
// provider answered. Nothing here sends or writes.

import type { ModelOperation, SenderReport } from '../../core-connectors/src/index.ts';
import type { BrokerRoute, Broker, ProviderAdapter } from './broker-types.ts';
import type { CustodyOutcome } from './custody.ts';
import type { DeliverRefusal } from './email-class.ts';

/** RFC 5322's dot-atom in ASCII: a from's local part, never a display name, space or line break. */
const DOT_ATOM = /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*$/u;
/** Printable ASCII: a domain that lower-cases to the verified subdomain only if it already is one. */
const ASCII = /^[!-~]+$/u;

/**
 * The report vouches for one subdomain: mail from anything but one bare address on it is not
 * verified, and only a report that says it is not from the fake source (`mock`) counts.
 */
export function fromVerifiedSender(
  from: string,
  sender: { readonly verified: boolean; readonly subdomain: string; readonly mock: boolean },
): boolean {
  const [local = '', domain = '', ...rest] = from.split('@');
  return (
    sender.verified &&
    sender.mock === false &&
    DOT_ATOM.test(local) &&
    rest.length === 0 &&
    ASCII.test(domain) &&
    domain.toLowerCase() === sender.subdomain.toLowerCase()
  );
}

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

export interface Routed {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly adapter: ProviderAdapter;
}

/** The catalogued send, its route and its adapter, or nothing when any is missing. */
function routed(broker: Broker): Routed | undefined {
  const operation = broker.operations.get(EMAIL_OPERATION);
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

/** What came back: the provider's message id, or the fault's kind. Never the answer's body. */
export function observed(
  outcome: CustodyOutcome,
  operation: ModelOperation,
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  if (outcome.kind === 'refused') return { state: 'failed', evidence: 'refused' };
  if (outcome.kind === 'worker_lost') return { state: 'failed', evidence: 'worker_lost' };
  if (!outcome.outbound.ok) return { state: 'failed', evidence: outcome.outbound.fault };
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return { state: 'failed', evidence: 'malformed' };
  }
  const answer = operation.answer(body);
  if (answer === undefined) return { state: 'failed', evidence: 'malformed' };
  return { state: 'accepted', evidence: `provider:${answer.text}` };
}
