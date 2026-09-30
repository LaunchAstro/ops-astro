// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.assign` with the agent assignee (Assign to AI). A task's assignee is
// a person or an agent, one at a time; the agent is a live delegation, in the
// task's `agent` field (migration 0051).
//
// **You assign your own AI.** The envelope has asked `task:assign` of the
// task, as for a person. Beyond that the delegation must be the assigner's
// own: another person's, and one this business does not hold, are the same
// `NOT_FOUND` naming `agent`, so nobody learns another person's agents exist.
// An owner or admin gets no exception. Then it must be live
// (`DELEGATION_NOT_LIVE`) and minted for this very task
// (`DELEGATION_OUT_OF_PURPOSE`): a delegation reaches one task, so one for
// another client's task never holds this one.
//
// **The lock.** The delegation row is read `for share` after the envelope's
// task lock, so a revoke (an update of that row) either commits first and is
// seen here as not live, or waits for this assignment and then clears it.
//
// **Assignment starts nothing.** It records who holds the task; a run still
// needs its own commands.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { FieldValues } from './requests.ts';
import { writeOwnedFields } from './tasks-state.ts';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** `task.assign` by a person: an agent, a person, or clearing either. */
export async function assignTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  const map = typeof fields === 'object' && fields !== null && !Array.isArray(fields);
  const agent: unknown = map ? fields['agent'] : undefined;
  const person: unknown = map ? fields['assignee'] : undefined;
  if (typeof agent !== 'string' || !UUID.test(agent)) {
    return await writeOwnedFields(tx, context, 'task.assign', oneKind(context, fields));
  }
  if (typeof person === 'string') {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['agent', 'assignee'],
        ['A task is assigned to a person or to an agent, not both at once.'],
      ),
    );
  }
  const refusal = await refuseAgent(tx, context, agent.toLowerCase());
  if (refusal !== undefined) return refused(refusal);
  return await writeOwnedFields(tx, context, 'task.assign', {
    ...fields,
    agent: agent.toLowerCase(),
    assignee: null,
  });
}

/**
 * A person write replaces an agent holder, and unassigning (`assignee: null`)
 * clears either kind: one kind at a time, whoever writes it.
 */
export function oneKind(context: Pick<CommandContext, 'target'>, fields: FieldValues): FieldValues {
  const held = typeof context.target?.data['agent'] === 'string';
  return held && 'assignee' in fields && !('agent' in fields) ? { ...fields, agent: null } : fields;
}

async function refuseAgent(
  tx: TenantQuery,
  context: CommandContext,
  delegationId: string,
): Promise<CommandRefusal | undefined> {
  const rows = await tx.query<{
    readonly delegate_person_id: string;
    readonly purpose_scope_id: string;
    readonly live: boolean;
  }>(
    `select delegate_person_id, purpose_scope_id,
            (revoked_at is null and settled_at is null and expires_at > now()) as live
       from public.delegations
      where business_id = $1 and id = $2
      for share`,
    [tx.businessId, delegationId],
  );
  const found = rows[0];
  if (found === undefined || found.delegate_person_id !== context.session.personId) {
    return refuseCommand(
      'NOT_FOUND',
      ['agent'],
      [
        'None of your own agents carries that identifier.',
        'Read the task: myAgents lists your agents that reach it.',
      ],
    );
  }
  if (!found.live) {
    return refuseCommand(
      'DELEGATION_NOT_LIVE',
      ['agent'],
      ['This delegation is revoked, settled or expired, so it holds no task.'],
    );
  }
  if (found.purpose_scope_id !== context.target?.id) {
    return refuseCommand(
      'DELEGATION_OUT_OF_PURPOSE',
      ['agent'],
      ['This delegation was minted for another task, and reaches only that one.'],
    );
  }
  return undefined;
}
