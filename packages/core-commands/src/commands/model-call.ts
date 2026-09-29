// SPDX-License-Identifier: AGPL-3.0-only
//
// `model.call`, the agent's priced model call (AW-01).

import type {
  BusinessId,
  Database,
  TenantQuery,
  VerifiedSubject,
} from '../../../core-records/src/index.ts';
import type { Broker } from '../../../core-custody/src/index.ts';
import type { AgentRequest } from './agent-call.ts';
import type { CommandContext } from './context.ts';
import type { HandlerOutcome } from './outcome.ts';
import type { CommandResult } from './register-store.ts';

/** The broker as a deployment configures it. The audit is this layer's, per caller. */
export type ModelBroker = Omit<Broker, 'audit'>;

/** The agent prefix's executor for `model.call`, the composition root's to build. */
export type ModelCallExecutor = (
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  credential: string | undefined,
  request: AgentRequest,
) => Promise<CommandResult>;

export function modelCallExecutor(_broker: ModelBroker): ModelCallExecutor {
  return () => Promise.reject(new Error('model.call: not built'));
}

export function refuseModelCallAsPerson(
  _tx: TenantQuery,
  _context: CommandContext,
): Promise<HandlerOutcome> {
  return Promise.reject(new Error('model.call: not built'));
}
