// SPDX-License-Identifier: AGPL-3.0-only
//
// The two pieces every broker email send shares (the inbox item's in
// `broker-email.ts`, C39-T's invitation in `broker-invitation.ts`): the
// catalogued `email.send` and its route, and the one reading of what the
// provider answered. Nothing here sends or writes.

import type { ModelOperation } from '../../core-connectors/src/index.ts';
import type { BrokerRoute, Broker, ProviderAdapter } from './broker-types.ts';
import type { CustodyOutcome } from './custody.ts';

/** The catalogued name the send dispatches by. */
export const EMAIL_OPERATION = 'email.send';

export interface Routed {
  readonly operation: ModelOperation;
  readonly route: BrokerRoute;
  readonly adapter: ProviderAdapter;
}

/** The catalogued send, its route and its adapter, or nothing when any is missing. */
export function routed(broker: Broker): Routed | undefined {
  const operation = broker.operations.get(EMAIL_OPERATION);
  if (operation === undefined) return undefined;
  const route = broker.routes.find((entry) => entry.provider === operation.provider);
  const adapter = broker.providers.get(operation.provider);
  return route === undefined || adapter === undefined ? undefined : { operation, route, adapter };
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
