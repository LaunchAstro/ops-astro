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
// A scope task outside the reader's `task:read` reach is decided in the
// statement (`SHOWN`): neither its subject nor a title taken from the subject
// leaves Postgres, and the scope is not returned (catalogue #412). A wrap-up's
// pointers (`contentsForReader`) and the page are served per reader.

import {
  checkAuthority,
  coveredScopes,
  isUuid,
  readableScope,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { ReadableScope, Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ConversationListResult,
  ConversationMessageView,
  ConversationReadResult,
} from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import { conversationAddress, DEFAULT_TITLE } from '../commands/conversations.ts';
import {
  addressReader,
  wrapUpView,
  type ReadsAddress,
  type WrapUpRow,
} from '../commands/conversation-contents.ts';

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
  readonly page_address: string | null;
  readonly page_shows: string | null;
  readonly created_at: Date;
  readonly last_activity_at: Date;
  readonly body_purged_at: Date | null;
}

/** The body, oldest first. */
async function messagesOf(
  tx: TenantQuery,
  conversationId: string,
): Promise<readonly ConversationMessageView[]> {
  const rows = await tx.query<{
    id: string;
    role: 'person' | 'agent';
    body: string;
    created_at: Date;
  }>(
    `select id, role, body, created_at from conversation_messages
      where business_id = $1 and conversation_id = $2
      order by created_at, id`,
    [tx.businessId, conversationId],
  );
  return rows.map((message) => ({
    id: message.id,
    role: message.role,
    body: message.body,
    createdAt: message.created_at.toISOString(),
  }));
}

/**
 * Whether the row's scope task is within the reader's reach ($3 a business
 * grant, $4 the granted records), and the title as that reader sees it: one
 * taken from an unreadable task's subject leaves as the default ($5).
 */
const SHOWN = `(scope_record_id is null or $3::boolean or scope_record_id = any($4::uuid[]))`;
const TITLE = `case when ${SHOWN} or title is distinct from subject then title else $5 end as title`;
const reach = (tasks: ReadableScope) => [tasks.business, tasks.records, DEFAULT_TITLE];

/** The conversation's own fields; its page names a task only to a reader who may read it. */
function conversationView(
  row: ConversationRow,
  reads: ReadsAddress,
): ConversationReadResult['conversation'] {
  return {
    id: row.id,
    address: conversationAddress(row.id),
    title: row.title,
    subject: row.subject,
    scope:
      row.scope_kind === null || row.scope_record_id === null
        ? null
        : { kind: row.scope_kind, id: row.scope_record_id },
    page:
      row.page_address === null || row.page_shows === null || !reads(row.page_address)
        ? null
        : { address: row.page_address, shows: row.page_shows },
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    bodyPurgedAt: row.body_purged_at?.toISOString() ?? null,
  };
}

async function served(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
): Promise<ConversationReadResult> {
  const tasks = await readableScope(tx, subjectsOf(session), 'task', 'read');
  const rows = await tx.query<ConversationRow>(
    `select id, ${TITLE}, case when ${SHOWN} then subject end as subject,
            case when ${SHOWN} then scope_kind end as scope_kind,
            case when ${SHOWN} then scope_record_id end as scope_record_id,
            page_address, page_shows, created_at, last_activity_at, body_purged_at
       from conversations where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, ...reach(tasks)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('conversation.read: the conversation went between reads');
  const messages = row.body_purged_at === null ? await messagesOf(tx, conversationId) : null;
  const wrapUps = await tx.query<WrapUpRow>(
    `select version, created_at, written_by_operation, code_revision, definition_version,
            request_quotation, items, left_open
       from conversation_wrap_ups
      where business_id = $1 and conversation_id = $2
      order by version desc`,
    [tx.businessId, conversationId],
  );
  const current = wrapUps[0];
  const reads = addressReader(tasks);
  return {
    ok: true,
    conversation: conversationView(row, reads),
    messages,
    wrapUp: current === undefined ? null : wrapUpView(current, reads),
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
  return await served(tx, session, conversationId);
}

const LIST_LIMIT = 50;

/**
 * `conversation.list`: the caller's own conversations for the tab row
 * (MP-7-11, CS-7.32), newest activity first, at most fifty. The owner filter
 * is in the statement: a read-any grant reads a conversation at its address
 * and never lists another person's. A caller who no longer holds
 * `conversation:write` is refused as the read refuses them, and a caller
 * with no membership holds no grant to list by.
 */
export async function listConversations(
  tx: TenantQuery,
  session: Session,
): Promise<ConversationListResult | CommandRefusal> {
  const own = await checkAuthority(tx, subjectsOf(session), {
    collection: COLLECTION,
    action: 'write',
    scope: { kind: 'business', id: null },
  });
  if (session.roleKey === null || !own.ok) return HOLDS_NOTHING;
  const tasks = await readableScope(tx, subjectsOf(session), 'task', 'read');
  const rows = await tx.query<
    Pick<ConversationRow, 'id' | 'title' | 'last_activity_at' | 'body_purged_at'>
  >(
    `select id, ${TITLE}, last_activity_at, body_purged_at from conversations
      where business_id = $1 and owner_actor_id = $2
      order by last_activity_at desc, id
      limit ${String(LIST_LIMIT)}`,
    [tx.businessId, session.actorId, ...reach(tasks)],
  );
  return {
    ok: true,
    conversations: rows.map((row) => ({
      id: row.id,
      address: conversationAddress(row.id),
      title: row.title,
      lastActivityAt: row.last_activity_at.toISOString(),
      bodyPurged: row.body_purged_at !== null,
    })),
  };
}
