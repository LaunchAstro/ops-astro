// SPDX-License-Identifier: AGPL-3.0-only
//
// `definition.read`'s replay (`agent-replay.ts`, #1904).

import type { TenantQuery, VerifiedSubject } from '../../../core-records/src/index.ts';
import type { CommandHandle, CommandResult } from './register-store.ts';
import { authorise } from './agent-authority.ts';
import type { TypedOperation } from './agent-operations.ts';
import { isRefused } from './outcome.ts';
import { workJudged } from './agent-standing.ts';
import type { AgentCall } from './agent-call.ts';
import { keptRead, type DefinitionReadOperands } from './definition-read-agent.ts';

/**
 * A pinned read's replay (#1904): always an answer or a refusal, never the
 * stored row, which holds no text. The call is authorised as a fresh one and
 * its read runs again under `workJudged` on the stored lease, fence, step and
 * run, never the body's, then the final lease check (`definition-read-agent.ts`).
 * It writes no ledger row, copy or event.
 */
export async function replayDefinitionRead<O extends object>(
  tx: TenantQuery,
  call: AgentCall,
  operation: TypedOperation<O>,
  stored: CommandHandle,
  verified: VerifiedSubject,
): Promise<CommandResult> {
  const again = keptRead(stored.detail);
  if (again === undefined) throw new Error('definition.read: a stored read without its lease');
  const authorised = await authorise(tx, call, operation);
  if ('refusal' in authorised) return authorised.refusal;
  const operands: DefinitionReadOperands = { ...again, again };
  const judged = { call, presented: verified, authority: operation.authority };
  const outcome = await workJudged(
    tx,
    judged,
    // The row's own serve, which reads `again` in place of a fresh read.
    async () => await authorised.run(operands as unknown as O),
    operation.final,
  );
  if ('ended' in outcome) return outcome.ended;
  if (isRefused(outcome)) return outcome.refusal;
  return { command: call.request.command, ...outcome };
}
