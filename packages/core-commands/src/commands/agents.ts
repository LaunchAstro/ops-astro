// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's own agents (Assign to AI): `agent.create` makes one, owned by the
// caller and named; `agent.rename` renames one of the caller's own. No grant
// is asked (`authorisedOn: 'self'`), so each asks here that the caller is a
// member of the business signed in as themselves: a client's person, a person
// on a share alone and an agent credential make no agent. Another person's
// agent, and one of another business, are the same `NOT_FOUND` on `agentId`.
// The applied detail carries the agent's id alone.

import {
  AGENT_NAME_LIMIT,
  agentNameOf,
  createAgent,
  INTERNAL_ROLE_KEYS,
  renameAgent,
  type TenantQuery,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand } from './refusal.ts';

const BAD_NAME = refused(
  refuseCommand(
    'FIELD_VALUE_INVALID',
    ['name'],
    [`Name the agent in 1 to ${String(AGENT_NAME_LIMIT)} characters, with no control character.`],
  ),
);

/** Refused unless the caller is a member of the business, signed in as themselves. */
function notAMember(context: CommandContext): HandlerOutcome | undefined {
  const { session } = context;
  const member = session.roleKey !== null && INTERNAL_ROLE_KEYS.includes(session.roleKey);
  if (member && session.credentialScope === undefined) return undefined;
  return refused(
    refuseCommand(
      'SCOPE_NOT_GRANTED',
      [],
      ['Only a member of the business makes or renames an agent, signed in as themselves.'],
    ),
  );
}

/** `agent.create`: a new agent of the caller's own. */
export async function makeAgent(
  tx: TenantQuery,
  context: CommandContext,
  value: unknown,
): Promise<HandlerOutcome> {
  const outside = notAMember(context);
  if (outside !== undefined) return outside;
  const name = agentNameOf(value);
  if (name === undefined) return BAD_NAME;
  const agentId = await createAgent(tx, context.session.personId, name);
  return applied(null, null, { agentId });
}

/** `agent.rename`: a new name for one of the caller's own agents. */
export async function renameOwnAgent(
  tx: TenantQuery,
  context: CommandContext,
  agentId: string,
  value: unknown,
): Promise<HandlerOutcome> {
  const outside = notAMember(context);
  if (outside !== undefined) return outside;
  const name = agentNameOf(value);
  if (name === undefined) return BAD_NAME;
  if (!(await renameAgent(tx, context.session.personId, agentId.toLowerCase(), name))) {
    return refused(
      refuseCommand(
        'NOT_FOUND',
        ['agentId'],
        ['None of your own agents carries that identifier.', 'Read agent.mine for your agents.'],
      ),
    );
  }
  return applied(null, null, { agentId: agentId.toLowerCase() });
}
