// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04's planning budget (U10): not built. A planning reply goes through the
// unpriced conversation seam, and no allowance is read.

import type { BusinessId, Database, TenantQuery } from '../../core-records/src/index.ts';
import { callModelInConversation, type ConversationCallRequest } from './broker-conversation.ts';
import type { Broker, ModelCaller, ModelCallResult } from './broker-types.ts';

export interface PlanningAllowance {
  readonly set: boolean;
  readonly currency: string | null;
  readonly limitMinor: number;
  readonly leftMinor: number;
  readonly conversation: { readonly spentMinor: number; readonly heldMinor: number };
}

export async function callModelForPlanning(
  database: Database,
  businessId: BusinessId,
  caller: ModelCaller,
  request: ConversationCallRequest,
  broker: Broker,
): Promise<ModelCallResult> {
  return await callModelInConversation(database, businessId, caller, request, broker);
}

export async function readPlanningAllowance(
  _tx: TenantQuery,
  _personId: string,
  _conversationId: string,
): Promise<PlanningAllowance> {
  return await Promise.resolve({
    set: false,
    currency: null,
    limitMinor: 0,
    leftMinor: 0,
    conversation: { spentMinor: 0, heldMinor: 0 },
  });
}
