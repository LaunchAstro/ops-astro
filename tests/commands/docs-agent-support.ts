// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs agent path's shared helpers (#2519), for docs-agent.test.ts and
// docs-agent-moves.test.ts: a delegation minted as the runtime mints one, the task and
// delegation a Docs row names, and how many Docs rows a business holds.

import { randomUUID } from 'node:crypto';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import type { Member } from './fixture.ts';
import type { AgentWorld } from './agent-fixture.ts';

export const idOf = (answer: CommandResult, field: string): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as Record<string, unknown>)[field]);
};

/**
 * A delegation for one task carrying `collections` x write, as the runtime mints one: asked of the
 * person's business-wide grants, or, `onTheTask`, of what they hold on that task alone.
 */
export async function mintDocsDelegation(
  world: AgentWorld,
  person: Member,
  taskId: string,
  collections: readonly string[],
  onTheTask = false,
): Promise<{ readonly credential: string; readonly id: string }> {
  return await world.db.app.withBusiness(world.business, async (tx) => {
    const minted = await mintDelegation(tx, {
      agentActorId: world.agentActorId,
      delegatePersonId: person.personId,
      mintedByActorId: person.actorId,
      purpose: `docs_${randomUUID().replaceAll('-', '')}`,
      collections: [...collections],
      actions: ['write'],
      purposeScope: { kind: 'record', id: taskId },
      expiresAt: new Date(Date.now() + 3_600_000),
      ...(onTheTask ? { holders: [{ kind: 'person' as const, id: person.personId }] } : {}),
    });
    if (!minted.ok) throw new Error(`delegation refused ${minted.refusal.code}`);
    return { credential: minted.value.credential, id: minted.value.delegation.id };
  });
}

/** Folders plus page versions in the business: a refused write leaves it unchanged. */
export async function docsRowCount(world: AgentWorld): Promise<number> {
  const [row] = await world.db.admin.execute<{ readonly n: number }>(
    `select ((select count(*) from public.docs_folders where business_id = $1)
           + (select count(*) from public.docs_page_versions where business_id = $1))::int as n`,
    [world.business],
  );
  return row?.n ?? -1;
}

/** The task and delegation each row of `table` keyed by `column` names, oldest version first. */
export async function namedOnRows(
  world: AgentWorld,
  table: 'docs_folders' | 'docs_page_versions',
  column: string,
  id: string,
): Promise<readonly { readonly task: string | null; readonly delegation: string | null }[]> {
  const order = table === 'docs_page_versions' ? 'order by number' : '';
  const rows = await world.db.admin.execute<{ task: string | null; delegation: string | null }>(
    `select task_id::text as task, delegation_id::text as delegation
       from public.${table} where business_id = $1 and ${column} = $2 ${order}`,
    [world.business, id],
  );
  return rows.map(({ task, delegation: by }) => ({ task, delegation: by }));
}
