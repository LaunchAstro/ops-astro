// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's conversation seam (ORCH35, option a): a person's model call from
// their own conversation, which has no task lease, run, step or approved
// version. Local routes only and unpriced: no money moves, so nothing is
// reserved, and a cloud route is refused before anything is written (AW-03
// egress off). Priced conversation spend is the owner's call, later.

import type { BusinessId, Database } from '../../core-records/src/index.ts';
import type { Broker, ClaimedField, ModelCaller, ModelCallResult } from './broker-types.ts';

/**
 * The conversation as the command layer found it, from its own row under the
 * caller's business (the conversation's table and its checks are SL12's; the
 * foreign key joins at the batch 3 join). The broker rechecks each fact
 * against the authenticated caller, never the body.
 */
export interface ConversationScope {
  readonly id: string;
  readonly businessId: string;
  readonly ownerPersonId: string;
}

export interface ConversationCallRequest {
  readonly conversation: ConversationScope;
  readonly operation: string;
  readonly fields: readonly ClaimedField[];
}

export async function callModelInConversation(
  _database: Database,
  _businessId: BusinessId,
  _caller: ModelCaller,
  _request: ConversationCallRequest,
  _broker: Broker,
): Promise<ModelCallResult> {
  return await Promise.reject(new Error('AW-01 conversation call: not built'));
}
