// SPDX-License-Identifier: AGPL-3.0-only
//
// The broker's email send (AW-07b): the only way a person is told by email
// that an inbox item waits. The delivery worker names an item and nothing
// else; the recipient, their address and the link are read here, and the
// message leaves through custody under the catalogued `email.send`.
//
// 1. Check, in the item's business: the operation is catalogued and routed,
//    the item is open, its recipient can read its task now (so another
//    client's task is never mailed about), they have a confirmed address, and
//    no earlier email attempt on the item might have gone out. A refusal
//    writes nothing and sends nothing. Then the attempt is recorded `asked`.
// 2. Send, through custody, a request the adapter built from the declared
//    fields. The body carries the item's address and never a decision.
// 3. Record what came back as the attempt's next observation: `accepted`
//    with the provider's message id, or `failed` with the fault's kind. No
//    answer body, address or link is kept, returned or written anywhere.
//
// Nothing here reads a provider answer as an instruction, and no path from
// an answer reaches the item's work state or any gate: an attempt never
// moves the item (`recordDeliveryAttempt`).

import {
  recordDeliveryAttempt,
  taskAccess,
  type BusinessId,
  type Database,
  type TenantQuery,
} from '../../core-records/src/index.ts';
import type { ModelOperation, SenderReport } from '../../core-connectors/src/index.ts';
import type { Broker, BrokerRoute, ProviderAdapter } from './broker-types.ts';
import type { CustodyOutcome } from './custody.ts';

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

/** Where the installation's own pages are, and who its mail is from. */
export interface MailSettings {
  readonly appOrigin: string;
  readonly from: string;
  /** The sending subdomain's setup check (`checkSender`): nothing is sent until it verified. */
  readonly sender: SenderReport;
}

export type EmailRefusal =
  | 'SENDER_NOT_VERIFIED'
  | 'OPERATION_NOT_CATALOGUED'
  | 'ITEM_NOT_OPEN'
  | 'ITEM_WITHHELD'
  | 'NO_ADDRESS'
  | 'EMAIL_MAY_HAVE_GONE';

export type EmailResult =
  | { readonly ok: true; readonly attemptId: string; readonly state: 'accepted' }
  | { readonly ok: false; readonly code: EmailRefusal }
  | {
      readonly ok: false;
      readonly code: 'EMAIL_FAILED';
      readonly attemptId: string;
      readonly fault: string;
    };

/**
 * Failures that prove the provider took nothing: it never reached them, or
 * refused before sending. Any other fault may have sent, so it is never
 * followed by a second send.
 */
const NOTHING_SENT: ReadonlySet<string> = new Set([
  'refused',
  'unlisted',
  'bad_path',
  'forbidden',
  'redirect',
  'status',
]);

interface Routed {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly adapter: ProviderAdapter;
}

function routed(broker: Broker): Routed | undefined {
  const operation = broker.operations.get(EMAIL_OPERATION);
  if (operation === undefined) return undefined;
  const route = broker.routes.find((entry) => entry.provider === operation.provider);
  const adapter = broker.providers.get(operation.provider);
  return route === undefined || adapter === undefined ? undefined : { operation, route, adapter };
}

/** The item's last email observation allows a send: none yet, or a failure that proves nothing went. */
async function mayStillSend(tx: TenantQuery, itemId: string): Promise<boolean> {
  const [last] = await tx.query<{ readonly state: string; readonly evidence: string | null }>(
    `select state, evidence from public.inbox_delivery_attempts
      where business_id = $1 and item_id = $2 and channel = 'email'
      order by observed_seq desc limit 1`,
    [tx.businessId, itemId],
  );
  return last === undefined || (last.state === 'failed' && NOTHING_SENT.has(last.evidence ?? ''));
}

/** Step 1: every check, then the `asked` observation. The address stays in this process. */
async function ask(
  tx: TenantQuery,
  itemId: string,
): Promise<{ readonly attemptId: string; readonly to: string } | EmailRefusal> {
  const [item] = await tx.query<{ readonly recipient: string; readonly subject: string }>(
    `select recipient_person_id as recipient, subject_record_id as subject
       from public.inbox_items
      where business_id = $1 and id = $2 and work_state = 'open'
      for update`,
    [tx.businessId, itemId],
  );
  if (item === undefined) return 'ITEM_NOT_OPEN';
  if ((await taskAccess(tx, item.recipient, item.subject)) !== 'readable') return 'ITEM_WITHHELD';
  const [address] = await tx.query<{ readonly value: string }>(
    `select value from public.person_identifiers
      where business_id = $1 and person_id = $2 and kind = 'email' and review_state = 'confirmed'
      order by last_observed_at desc, id limit 1`,
    [tx.businessId, item.recipient],
  );
  if (address === undefined) return 'NO_ADDRESS';
  if (!(await mayStillSend(tx, itemId))) return 'EMAIL_MAY_HAVE_GONE';
  const attemptId = await recordDeliveryAttempt(tx, { itemId, channel: 'email', state: 'asked' });
  return { attemptId, to: address.value };
}

/** Step 3's reading: the provider's message id, or the fault's kind. Never the answer's body. */
function observed(
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

/** Tell an inbox item's recipient by email where to go, through the broker only. */
export async function sendInboxEmail(
  database: Database,
  businessId: BusinessId,
  itemId: string,
  broker: Broker,
  mail: MailSettings,
): Promise<EmailResult> {
  const found = routed(broker);
  if (found === undefined) return { ok: false, code: 'OPERATION_NOT_CATALOGUED' };
  const { operation, route, adapter } = found;
  const asked = await database.withBusiness(businessId, async (tx) => await ask(tx, itemId));
  if (typeof asked === 'string') return { ok: false, code: asked };
  const address = new URL(`/inbox/${encodeURIComponent(itemId)}`, mail.appOrigin).href;
  const built = adapter.build({ to: asked.to, from: mail.from, address });
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
    async (tx) => await recordDeliveryAttempt(tx, { itemId, channel: 'email', ...seen }),
  );
  if (seen.state === 'accepted') return { ok: true, attemptId, state: 'accepted' };
  return { ok: false, code: 'EMAIL_FAILED', attemptId, fault: seen.evidence };
}
