// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.check`: a check the run performed, recorded under its worker lease
// (MP-6-1, CS-16.3). The operands are read and refused here, once for both
// entries; the runtime's `recordCheck` locks the lease and re-checks that the
// caller holds it live before anything is written. The agent's entry passes
// the actor and delegation its credential resolved to, the person's entry the
// verified session: neither comes from the body.

import type { Subject, TenantQuery } from '../../../core-records/src/index.ts';
import {
  CHECK_OUTCOMES,
  NOT_OWNED_FIX,
  leaseReason,
  recordCheck,
  type CheckOutcome,
  type CheckRequest,
} from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { refuseCommand } from './refusal.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { personClaimant, type AgentClaimant } from './tasks-claimant.ts';

const NAME_LIMIT = 120;
const NOTE_LIMIT = 500;

export interface CheckFields {
  readonly leaseId: unknown;
  readonly fence: unknown;
  readonly name: unknown;
  readonly outcome: unknown;
  readonly note?: unknown;
}

type Caller =
  | { readonly claimant: 'agent'; readonly holderActorId: string; readonly delegationId: string }
  | {
      readonly claimant: 'person';
      readonly holderActorId: string;
      readonly subjects: readonly Subject[];
      readonly collection: string;
    };

const isOutcome = (value: unknown): value is CheckOutcome =>
  (CHECK_OUTCOMES as readonly unknown[]).includes(value);

async function recordAs(
  tx: TenantQuery,
  fields: CheckFields,
  caller: Caller,
): Promise<HandlerOutcome> {
  const invalid = [
    ...(typeof fields.name === 'string' &&
    fields.name.trim() !== '' &&
    fields.name.length <= NAME_LIMIT
      ? []
      : ['name']),
    ...(isOutcome(fields.outcome) ? [] : ['outcome']),
    ...(fields.note === undefined ||
    fields.note === null ||
    (typeof fields.note === 'string' &&
      fields.note.trim() !== '' &&
      fields.note.length <= NOTE_LIMIT)
      ? []
      : ['note']),
    ...(typeof fields.fence === 'number' && Number.isSafeInteger(fields.fence) ? [] : ['fence']),
  ];
  if (invalid.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', invalid, [
        `Name the check in 1 to ${NAME_LIMIT} characters, give its outcome as one of ${CHECK_OUTCOMES.join(', ')}, a note of at most ${NOTE_LIMIT} if any, and the fence the pickup handed back.`,
      ]),
    );
  }
  if (!isIdentifier(fields.leaseId)) {
    return refused(
      refuseCommand('LEASE_NOT_OWNED', [], [leaseReason('not_owned'), NOT_OWNED_FIX.check]),
    );
  }
  const result = await recordCheck(tx, {
    ...caller,
    leaseId: fields.leaseId,
    fence: fields.fence as number,
    name: fields.name as string,
    outcome: fields.outcome as CheckOutcome,
    note: typeof fields.note === 'string' ? fields.note : null,
  } as CheckRequest);
  if (!result.ok) return refused(result.refusal);
  return applied(result.value.taskId, null, {
    checkId: result.value.checkId,
    versionId: result.value.versionId,
    runId: result.value.runId,
    outcome: fields.outcome,
  });
}

/** A person records a check under the lease their own pickup took. */
export async function checkOwnLease(
  tx: TenantQuery,
  context: CommandContext,
  fields: CheckFields,
): Promise<HandlerOutcome> {
  const person = personClaimant(context);
  return await recordAs(tx, fields, {
    claimant: 'person',
    holderActorId: person.actorId,
    subjects: person.subjects,
    collection: person.collection,
  });
}

/** The agent records a check under its own lease and the delegation it presented. */
export async function checkLease(
  tx: TenantQuery,
  fields: CheckFields,
  agent: AgentClaimant,
  delegationId: string,
): Promise<HandlerOutcome> {
  return await recordAs(tx, fields, {
    claimant: 'agent',
    holderActorId: agent.actorId,
    delegationId,
  });
}
