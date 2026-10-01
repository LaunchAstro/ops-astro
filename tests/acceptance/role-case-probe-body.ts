// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's probe body, split from role-case-harness.ts when the main merge joined it past
// the line limit. The harness hands it the task every case can name.

import { randomUUID } from 'node:crypto';
import type { CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import { breachDrillBody, childProbe, type Task } from './role-case-bodies.ts';
import { targetKeyOf } from './role-case-harness-shape.ts';

/**
 * The least a caller can send and still be asking the operation its own
 * question, for the cases whose answer arrives before the body is read.
 *
 * `recordId` is sent only where the declaration names a record by it, because
 * `prepare.ts` refuses an identifier on a command that has no use for one —
 * `COMMAND_BODY_INVALID`, and before the authority check — so a body that was
 * uniform across the table would have measured that refusal rather than the
 * authority one the case is about.
 */
export function probeBody(
  declaration: CommandDeclaration,
  alphaTask: Task,
): Readonly<Record<string, unknown>> {
  const targeted = declaration.targetsExistingRecord;
  return {
    operationId: randomUUID(),
    ...(targetKeyOf(declaration) === 'recordId' ? { recordId: alphaTask.id } : {}),
    ...(targeted ? { expectedRevision: alphaTask.revision } : {}),
    ...(declaration.name === 'task.board' ? { board: null } : {}),
    ...(declaration.name === 'task.receipt' ? { attemptId: randomUUID() } : {}),
    ...(declaration.name === 'task.search' ? { query: 'brochure' } : {}),
    ...(declaration.name === 'task.ledger' ? { timeZone: 'UTC' } : {}),
    ...(declaration.name === 'definition.attribution' ? { digest: 'a'.repeat(64) } : {}),
    ...(declaration.name === 'preset.plan'
      ? { recordTypeKey: 'task', presetKey: 'acceptance', fields: [] }
      : {}),
    ...(declaration.name === 'privacy.draft_breach_notices' ? breachDrillBody() : {}),
    // Well formed, so authority answers: operands are read by type before the delegation.
    ...(declaration.name === 'model.call'
      ? { leaseId: randomUUID(), fence: 1, operation: 'model.replay_compose', fields: [] }
      : {}),
    ...(declaration.name === 'run.delegate_child'
      ? { leaseId: randomUUID(), fence: 1, ...childProbe(randomUUID()) }
      : {}),
    ...(declaration.name === 'run.child_handback' ? { outcome: 'completed' } : {}),
  };
}
