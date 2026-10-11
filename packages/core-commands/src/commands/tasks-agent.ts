// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.assign` with the agent assignee (Assign to AI). A task's assignee is
// a person or an agent, one at a time; the agent is an agent actor of this
// business, in the task's `agent` field (migrations 0082, 20261011115838).
//
// **Who may hand a task to an agent.** The envelope has asked `task:assign`
// of the task, as for a person. Beyond that the assigner must direct the
// agent: own it, or hold `agent:assign` over the business
// (`authority/agents.ts`). An agent of another business, or a deactivated
// one, is `NOT_FOUND` naming `agent`; one of this business the assigner may
// not direct is `SCOPE_NOT_GRANTED` naming `agent`. Directing one through
// `agent:assign` is asked again once the task is written, after the
// business's audit-chain lock (its key `business_id::text`, lower case), the
// last wait: a grant that expired while the command waited refuses it, and the
// handler's savepoint takes the write back.
//
// **The assignment stays.** No delegation is asked for or checked, so no
// revocation or expiry takes the task back; a person's next `task.assign`
// changes it. Assigning starts nothing: a run asks for its own delegation.

import {
  advisoryLock,
  directsEveryAgent,
  mayDirectAgent,
  subjectsOf,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import type { FieldValues } from './requests.ts';
import { writeOwnedFields } from './tasks-state.ts';

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** What an agent's `task.assign` sets: the assignee (MP-4-8), not the delegate. */
export const AGENT_ASSIGN_FIELDS: readonly string[] = ['assignee'];

/** The refusal of fields an agent does not write through this command, naming them; none is written. */
export function outsideAgentReach(
  fields: FieldValues,
  reach: readonly string[],
): CommandRefusal | undefined {
  const outside = Object.keys(fields)
    .filter((key) => !reach.includes(key))
    .toSorted();
  if (outside.length === 0) return undefined;
  return refuseCommand('SCOPE_NOT_GRANTED', outside, [
    `An agent writes only ${reach.join(', ')} through this command.`,
  ]);
}

/**
 * `task.assign` by a person: an agent, a person, or clearing either. An agent
 * credential (API-2) reaches here as its agent and sets only what a delegated
 * agent sets, the assignee (#420).
 */
export async function assignTask(
  tx: TenantQuery,
  context: CommandContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  if (context.session?.credentialScope !== undefined) {
    const outside = outsideAgentReach(fields, AGENT_ASSIGN_FIELDS);
    if (outside !== undefined) return refused(outside);
  }
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
  const directing = await directingOf(tx, context, agent.toLowerCase());
  if (typeof directing !== 'string') return refused(directing);
  const written = await writeOwnedFields(tx, context, 'task.assign', {
    ...fields,
    agent: agent.toLowerCase(),
    assignee: null,
  });
  if (directing === 'own' || isRefused(written)) return written;
  await advisoryLock(tx, tx.businessId.toLowerCase());
  const still = await directsEveryAgent(tx, subjectsOf(context.session));
  return still ? written : refused(notYours());
}

/**
 * A person write replaces an agent holder, and unassigning (`assignee: null`)
 * clears either kind: one kind at a time, whoever writes it.
 */
export function oneKind(context: Pick<CommandContext, 'target'>, fields: FieldValues): FieldValues {
  const held = typeof context.target?.data['agent'] === 'string';
  return held && 'assignee' in fields && !('agent' in fields) ? { ...fields, agent: null } : fields;
}

/** How the assigner directs the agent, or the refusal when they may not. */
async function directingOf(
  tx: TenantQuery,
  context: CommandContext,
  agentId: string,
): Promise<'own' | 'granted' | CommandRefusal> {
  const { session } = context;
  const may = await mayDirectAgent(tx, session.personId, subjectsOf(session), agentId);
  if (may === 'missing') {
    return refuseCommand(
      'NOT_FOUND',
      ['agent'],
      [
        'No active agent of this business carries that identifier.',
        'Read the task: myAgents lists the agents you may hand it to.',
      ],
    );
  }
  return may === 'not-yours' ? notYours() : may;
}

function notYours(): CommandRefusal {
  return refuseCommand(
    'SCOPE_NOT_GRANTED',
    ['agent'],
    [
      "That agent belongs to someone else, and you may not direct other people's agents.",
      'Choose one of your own agents, or ask its owner to hand the task over.',
    ],
  );
}
