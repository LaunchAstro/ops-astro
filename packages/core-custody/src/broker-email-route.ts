// SPDX-License-Identifier: AGPL-3.0-only
//
// What every broker email send shares (the inbox item's in `broker-email.ts`,
// C39-T's invitation in `broker-invitation.ts`): the sender check, the
// catalogued `email.send` and its route, the reservation judged against a
// fresh sender report, and the one reading of what the provider answered.
// Nothing here sends.

import {
  senderFresh,
  type ModelOperation,
  type SenderReport,
} from '../../core-connectors/src/index.ts';
import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
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
  if (!senderVerifiedFor(mail.from, mail.sender, broker.custody)) return 'SENDER_NOT_VERIFIED';
  return routed(broker) ?? 'OPERATION_NOT_CATALOGUED';
}

/** Thrown inside a reservation's transaction to undo it: the sender report went stale. */
class StaleSender extends Error {}

/**
 * One send's reservation, in its own transaction: `ask` takes every lock and writes the token or
 * `asked`, then the sender report is judged, after the last lock the ask waited on. A report
 * that is no longer fresh rolls the reservation back, so nothing it wrote stands, and answers
 * `SENDER_NOT_VERIFIED`. The judgement before the locks (`sendRoute`) is only a first refusal.
 */
export async function reserveFresh<T>(
  database: Database,
  businessId: BusinessId,
  sender: SenderReport,
  ask: (tx: TenantQuery) => Promise<T>,
): Promise<T | 'SENDER_NOT_VERIFIED'> {
  try {
    return await database.withBusiness(businessId, async (tx) => {
      const asked = await ask(tx);
      // A refusal (a code) wrote nothing; a reservation stands only on a fresh report.
      if (typeof asked !== 'string' && !senderFresh(sender)) throw new StaleSender();
      return asked;
    });
  } catch (error) {
    if (error instanceof StaleSender) return 'SENDER_NOT_VERIFIED';
    throw error;
  }
}

/** What came back: the message id (whose: `source`), or the fault's kind. Never the body. */
export function observed(
  outcome: CustodyOutcome,
  operation: ModelOperation,
  source: 'provider' | 'mock',
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  if (outcome.kind === 'refused') return { state: 'failed', evidence: 'refused' };
  if (outcome.kind === 'worker_lost') return { state: 'failed', evidence: 'worker_lost' };
  // A withheld outcome comes only from a site template route.
  if (outcome.kind === 'withheld') return { state: 'failed', evidence: 'withheld' };
  if (!outcome.outbound.ok) return { state: 'failed', evidence: outcome.outbound.fault };
  let body: unknown;
  try {
    body = JSON.parse(outcome.outbound.body);
  } catch {
    return { state: 'failed', evidence: 'malformed' };
  }
  const answer = operation.answer(body);
  if (answer === undefined) return { state: 'failed', evidence: 'malformed' };
  return { state: 'accepted', evidence: `${source}:${answer.text}` };
}

/**
 * Accepted evidence with its message id kept only when the id carries no piece of the recipient's
 * local part, compared without case: the provider knows the address and may answer it back.
 */
export function withoutRecipient(
  seen: { readonly state: 'accepted' | 'failed'; readonly evidence: string },
  to: string,
): { readonly state: 'accepted' | 'failed'; readonly evidence: string } {
  if (seen.state !== 'accepted') return seen;
  const at = seen.evidence.indexOf(':');
  const id = seen.evidence.slice(at + 1).toLowerCase();
  const pieces =
    to
      .slice(0, to.lastIndexOf('@'))
      .toLowerCase()
      .match(/[a-z0-9-]+/gu) ?? [];
  if (!pieces.some((piece) => id.includes(piece))) return seen;
  return { state: 'accepted', evidence: `${seen.evidence.slice(0, at)}:withheld` };
}
