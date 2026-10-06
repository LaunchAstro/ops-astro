// SPDX-License-Identifier: AGPL-3.0-only
//
// What every broker email send shares (the inbox item's in `broker-email.ts`,
// C39-T's invitation in `broker-invitation.ts`): the sender check, the
// catalogued `email.send` and its route, and the one reading of what the
// provider answered. Nothing here sends or writes.

import type { ModelOperation, SenderReport } from '../../core-connectors/src/index.ts';
import type { BrokerRoute, Broker, ProviderAdapter } from './broker-types.ts';
import type { Custody, CustodyOutcome } from './custody.ts';
import type { DeliverRefusal } from './email-class.ts';
import { isLoopbackMock } from './email-mock-custody.ts';

/** RFC 5322's dot-atom in ASCII: a from's local part, never a display name, space or line break. */
const DOT_ATOM = /^[\w!#$%&'*+/=?^`{|}~-]+(?:\.[\w!#$%&'*+/=?^`{|}~-]+)*$/u;
/** Printable ASCII: a domain that lower-cases to the verified subdomain only if it already is one. */
const ASCII = /^[!-~]+$/u;
/** RFC 5321's limits in octets; both checks above take ASCII only, so a character is one octet. */
const MAX_LOCAL_OCTETS = 64;
const MAX_ADDRESS_OCTETS = 254;

/**
 * The report vouches for one subdomain: mail from anything but one bare address on it, within
 * RFC 5321's lengths, is not verified, and only a report that says it is not from the fake
 * source (`mock`) counts.
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
    local.length <= MAX_LOCAL_OCTETS &&
    from.length <= MAX_ADDRESS_OCTETS &&
    rest.length === 0 &&
    ASCII.test(domain) &&
    domain.toLowerCase() === sender.subdomain.toLowerCase()
  );
}

/**
 * The sender gate as one send sees it: a mock report counts as unmocked only
 * when the send's custody is the loopback mock `email-mock-custody.ts` started;
 * over any other custody it is refused, as `fromVerifiedSender` refuses every mock report.
 */
export function senderVerifiedFor(
  from: string,
  sender: Parameters<typeof fromVerifiedSender>[1],
  custody: Custody,
): boolean {
  const mockHere = sender.mock && isLoopbackMock(custody);
  return fromVerifiedSender(from, mockHere ? { ...sender, mock: false } : sender);
}

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
  if (!senderVerifiedFor(mail.from, mail.sender, broker.custody)) return 'SENDER_NOT_VERIFIED';
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

/** What came back: the message id (whose: `source`), or the fault's kind. Never the body. */
export function observed(
  outcome: CustodyOutcome,
  operation: ModelOperation,
  source: 'provider' | 'mock',
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  const answer = answerOf(outcome, operation);
  if (!answer.ok) return { state: 'failed', evidence: answer.fault };
  return { state: 'accepted', evidence: `${source}:${answer.text}` };
}
