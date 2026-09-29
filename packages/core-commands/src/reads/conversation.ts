// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.read`: a conversation at its address (AW-03).
//
// Who may read it is this module's rule, not the grant model's alone,
// because the owner reads their own without any read-any grant:
//
// - a caller with no membership (a client) is told `NOT_FOUND`, as for a
//   made-up id: a client never sees a body or a wrap-up, nor learns one
//   exists;
// - an id this business does not hold is `NOT_FOUND`, the same bytes for
//   another business's conversation as for a fabricated one;
// - the owner reads while they still hold `conversation:write`, so an owner
//   whose every grant is revoked is refused like anyone else;
// - anyone else needs `conversation:read` (the read-any grant, which nobody
//   holds on install) covering the conversation's scope: business-wide, or on
//   the task it was opened on. Without it, `SCOPE_NOT_GRANTED` with the
//   reason and nothing of the conversation.
//
// Each refusal is decided before any title, subject or message is selected.

import {
  checkAuthority,
  coveredScopes,
  isUuid,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ConversationMessageView,
  ConversationReadResult,
  WrapUpView,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { conversationAddress } from '../commands/conversations.ts';

const COLLECTION = 'conversation';

const NOT_THE_OWNER = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  [
    'A conversation is its owner’s alone; reading another person’s needs the read-any grant (conversation:read).',
    'Ask an administrator who may grant it.',
  ],
);

interface Door {
  readonly owner_actor_id: string;
  readonly scope_record_id: string | null;
}

async function mayRead(
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
  const any = await checkAuthority(tx, subjects, {
    collection: COLLECTION,
    action: 'read',
    scope:
      door.scope_record_id === null
        ? { kind: 'business', id: null }
        : { kind: 'record', id: door.scope_record_id },
  });
  return any.ok ? undefined : NOT_THE_OWNER;
}

interface ConversationRow {
  readonly id: string;
  readonly title: string;
  readonly subject: string | null;
  readonly scope_kind: 'task' | null;
  readonly scope_record_id: string | null;
  readonly created_at: Date;
  readonly last_activity_at: Date;
  readonly body_purged_at: Date | null;
}

interface WrapUpRow {
  readonly version: number;
  readonly created_at: Date;
  readonly written_by_operation: string;
  readonly code_revision: string;
  readonly definition_version: string | null;
  readonly request_quotation: string;
  readonly items: WrapUpView['items'];
  readonly left_open: WrapUpView['leftOpen'];
}

export const NOTHING_LEFT_OPEN = 'nothing left open';

export function leftOpenText(leftOpen: WrapUpView['leftOpen']): string {
  if (leftOpen.length === 0) return NOTHING_LEFT_OPEN;
  return `${String(leftOpen.length)} left open: ${leftOpen.map((pointer) => `${pointer.kind} ${pointer.id}`).join(', ')}`;
}

const wrapUpView = (row: WrapUpRow): WrapUpView => ({
  version: row.version,
  writtenAt: row.created_at.toISOString(),
  writtenBy: { operation: row.written_by_operation, codeRevision: row.code_revision },
  definitionVersion: row.definition_version,
  request: { quotation: row.request_quotation },
  items: row.items,
  leftOpen: row.left_open,
  leftOpenText: leftOpenText(row.left_open),
});

async function served(tx: TenantQuery, conversationId: string): Promise<ConversationReadResult> {
  const rows = await tx.query<ConversationRow>(
    `select id, title, subject, scope_kind, scope_record_id, created_at, last_activity_at,
            body_purged_at
       from conversations where business_id = $1 and id = $2`,
    [tx.businessId, conversationId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('conversation.read: the conversation went between reads');
  const messages =
    row.body_purged_at === null
      ? (
          await tx.query<{ id: string; role: 'person' | 'agent'; body: string; created_at: Date }>(
            `select id, role, body, created_at from conversation_messages
              where business_id = $1 and conversation_id = $2
              order by created_at, id`,
            [tx.businessId, conversationId],
          )
        ).map((message): ConversationMessageView => ({
          id: message.id,
          role: message.role,
          body: message.body,
          createdAt: message.created_at.toISOString(),
        }))
      : null;
  const wrapUps = await tx.query<WrapUpRow>(
    `select version, created_at, written_by_operation, code_revision, definition_version,
            request_quotation, items, left_open
       from conversation_wrap_ups
      where business_id = $1 and conversation_id = $2
      order by version desc`,
    [tx.businessId, conversationId],
  );
  const current = wrapUps[0];
  return {
    ok: true,
    conversation: {
      id: row.id,
      address: conversationAddress(row.id),
      title: row.title,
      subject: row.subject,
      scope:
        row.scope_kind === null || row.scope_record_id === null
          ? null
          : { kind: row.scope_kind, id: row.scope_record_id },
      createdAt: row.created_at.toISOString(),
      lastActivityAt: row.last_activity_at.toISOString(),
      bodyPurgedAt: row.body_purged_at?.toISOString() ?? null,
    },
    messages,
    wrapUp: current === undefined ? null : wrapUpView(current),
    wrapUpHistory: wrapUps.map((wrapUp) => ({
      version: wrapUp.version,
      writtenAt: wrapUp.created_at.toISOString(),
    })),
  };
}

/**
 * Whether the caller holds any conversation grant: `write` (their own) or
 * `read` (the read-any grant) at any scope. A caller holding neither is
 * refused before the identifier is looked at, in `checkAuthority`'s words.
 */
async function holdsAConversationGrant(tx: TenantQuery, session: Session): Promise<boolean> {
  const subjects = subjectsOf(session);
  for (const action of ['write', 'read'] as const) {
    // eslint-disable-next-line no-await-in-loop -- the second is asked only when the first is empty
    const held = await coveredScopes(tx, subjects, { collection: COLLECTION, action });
    if (held.business || held.records.length > 0) return true;
  }
  return false;
}

const HOLDS_NOTHING = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

export async function readConversation(
  tx: TenantQuery,
  session: Session,
  conversationId: unknown,
): Promise<ConversationReadResult | CommandRefusal> {
  if (session.roleKey === null) return refuseNotFound();
  if (!(await holdsAConversationGrant(tx, session))) return HOLDS_NOTHING;
  if (!isUuid(conversationId)) {
    return refuseCommand(
      'FIELD_VALUE_INVALID',
      ['conversationId'],
      ['Send conversationId as the conversation’s identifier.'],
    );
  }
  const doors = await tx.query<Door>(
    `select owner_actor_id, scope_record_id from conversations
      where business_id = $1 and id = $2`,
    [tx.businessId, conversationId],
  );
  const door = doors[0];
  if (door === undefined) return refuseNotFound();
  const refusal = await mayRead(tx, session, door);
  if (refusal !== undefined) return refusal;
  return await served(tx, conversationId);
}
