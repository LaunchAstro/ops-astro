// SPDX-License-Identifier: AGPL-3.0-only
//
// A subtask carries its parent's client (MP-4-4, `MP-4-4 parent scope`).
//
// The client (`uuid_7`) is the party a party-scoped grant resolves against,
// so a subtask under another client than its parent would put one client's
// work inside another's. Three writes could do that, and each keeps the rule:
// `task.create` copies the parent's client onto a new subtask, `task.reparent`
// refuses a parent whose client differs from the task's own, and
// `task.set_party` refuses a subtask a client of its own and carries a
// parent's new client down its whole live subtree in the same transaction.
// The business needs no rule of its own here: every lookup is filtered by the
// business the session set, so another business's parent is not found.

import { checkAuthority, slotOf, subjectsOf, TASK_SPINE } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from './refusal.ts';
import { isRefused, refused, type HandlerOutcome } from './outcome.ts';
import { writeOwnedFields } from './tasks-state.ts';
import type { CommandContext } from './context.ts';
import type { FieldValues } from './requests.ts';

const PARENT = slotOf(TASK_SPINE, 'parent');
const CLIENT = slotOf(TASK_SPINE, 'client');

/** The client a live task of this business carries, or null for none. */
export async function clientOf(
  tx: TenantQuery,
  taskTypeId: string,
  taskId: string,
): Promise<string | null> {
  const rows = await tx.query<{ readonly client: string | null }>(
    `select ${CLIENT}::text as client from public.records
      where business_id = $1 and record_type_id = $2 and id = $3 and deleted_at is null`,
    [tx.businessId, taskTypeId, taskId],
  );
  return rows[0]?.client ?? null;
}

export function refuseOtherClient(): CommandRefusal {
  return refuseCommand(
    'PLACEMENT_IS_DERIVED',
    ['client'],
    [
      'A subtask carries its parent’s client.',
      'Change the client on the top-level task: its subtasks follow it.',
    ],
  );
}

const DOWN = `with recursive down as (
     select id from records
      where business_id = $1 and record_type_id = $2 and ${PARENT} = $3 and deleted_at is null
     union all
     select child.id from records child join down on child.${PARENT} = down.id
      where child.business_id = $1 and child.record_type_id = $2 and child.deleted_at is null
   ) cycle id set looped using path`;

/**
 * The live subtree under `rootId`, locked, with the first descendant the
 * caller may not `share` on refused: the target's grant does not reach its
 * children (the same question `task.move` asks of a subtree, with the action
 * `task.set_party` is declared under).
 */
async function refuseUnsharedDescendants(
  tx: TenantQuery,
  context: CommandContext,
  rootId: string,
): Promise<CommandRefusal | undefined> {
  const found = await tx.query<{ readonly id: string }>(
    `${DOWN}
     select r.id from records r
      where r.business_id = $1 and r.id in (select id from down where not looped and id <> $3)
      for update of r`,
    [tx.businessId, context.spine.taskTypeId, rootId],
  );
  if (found.length === 0) return undefined;
  const subjects = subjectsOf(context.session);
  const whole = await checkAuthority(tx, subjects, {
    collection: 'task',
    action: 'share',
    scope: { kind: 'business', id: null },
  });
  if (whole.ok) return undefined;
  for (const { id } of found) {
    // Sequential, stopping at the first: the answer is the same whichever.
    // eslint-disable-next-line no-await-in-loop
    const reached = await checkAuthority(tx, subjects, {
      collection: 'task',
      action: 'share',
      scope: { kind: 'record', id },
    });
    if (!reached.ok) return reached.refusal;
  }
  return undefined;
}

/** `task.set_party`: the owned write, held to the parent's client and carried down. */
export async function setParty(
  tx: TenantQuery,
  context: CommandContext,
  fields: FieldValues,
): Promise<HandlerOutcome> {
  const target = context.target;
  if (target === undefined) throw new Error('setParty: the envelope read no target');
  const naming = typeof fields === 'object' && fields !== null && 'client' in fields;
  const sent = naming ? fields['client'] : undefined;
  const client = typeof sent === 'string' ? sent.toLowerCase() : null;
  const parentId = (target.data['parent'] as string | undefined) ?? null;
  if (naming && parentId !== null) {
    const theirs = await clientOf(tx, context.spine.taskTypeId, parentId);
    if (client !== theirs) return refused(refuseOtherClient());
  }
  if (naming) {
    const unshared = await refuseUnsharedDescendants(tx, context, target.id);
    if (unshared !== undefined) return refused(unshared);
  }
  const written = await writeOwnedFields(tx, context, 'task.set_party', fields);
  if (isRefused(written) || !naming) return written;
  await tx.query(
    `${DOWN}
     update records
        set data = case when $4::text is null then data - 'client'
                        else jsonb_set(data, '{client}', to_jsonb($4::text)) end
      where business_id = $1 and id in (select id from down where not looped and id <> $3)`,
    [tx.businessId, context.spine.taskTypeId, target.id, typeof sent === 'string' ? sent : null],
  );
  return written;
}
