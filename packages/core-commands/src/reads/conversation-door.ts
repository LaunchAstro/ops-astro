// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may read a conversation (`conversation.read`, AW-03): the rule the read
// asks before any title, subject or message is selected. A task's client is
// read from its record in the same statement as the door, so a party grant
// reaches the conversations opened on that client's tasks and no others.

import { checkAuthority, subjectsOf } from '../../../core-records/src/index.ts';
import type { Scope, Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, type CommandRefusal } from '../commands/refusal.ts';

const COLLECTION = 'conversation';

const NOT_THE_OWNER = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  [
    'A conversation is its owner’s alone; reading another person’s needs the read-any grant (conversation:read).',
    'Ask an administrator who may grant it.',
  ],
);

export interface Door {
  readonly owner_actor_id: string;
  readonly scope_record_id: string | null;
  readonly scope_client: string | null;
}

/** Who opened the conversation and what it was opened on, before anything of it is read. */
export async function doorOf(tx: TenantQuery, conversationId: string): Promise<Door | undefined> {
  const doors = await tx.query<Door>(
    `select c.owner_actor_id, c.scope_record_id, r.uuid_7::text as scope_client
       from conversations c left join records r
         on r.business_id = c.business_id and r.id = c.scope_record_id
      where c.business_id = $1 and c.id = $2`,
    [tx.businessId, conversationId],
  );
  return doors[0];
}

/**
 * The owner while they hold `conversation:write`; anyone else on a
 * `conversation:read` grant covering the scope: business-wide, the task, or
 * that task's client.
 */
export async function mayRead(
  tx: TenantQuery,
  session: Session,
  door: Door,
): Promise<CommandRefusal | undefined> {
  const subjects = subjectsOf(session);
  if (door.owner_actor_id === session.actorId) {
    const own = await checkAuthority(tx, subjects, {
      collection: COLLECTION,
      action: 'write',
      scope: { kind: 'business', id: null },
    });
    return own.ok ? undefined : own.refusal;
  }
  const scopes: readonly Scope[] =
    door.scope_record_id === null
      ? [{ kind: 'business', id: null }]
      : [{ kind: 'record', id: door.scope_record_id }];
  const party: readonly Scope[] =
    door.scope_client === null ? [] : [{ kind: 'party', id: door.scope_client }];
  for (const scope of [...scopes, ...party]) {
    // oxlint-disable-next-line no-await-in-loop -- the record, then its client
    const any = await checkAuthority(tx, subjects, {
      collection: COLLECTION,
      action: 'read',
      scope,
    });
    if (any.ok) return undefined;
  }
  return NOT_THE_OWNER;
}
