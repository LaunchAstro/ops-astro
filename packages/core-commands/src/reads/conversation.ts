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
//   holds on install) covering the conversation's scope: business-wide, on
//   the task it was opened on, or on that task's client (a party grant reaches
//   that client's tasks only). Without it, `SCOPE_NOT_GRANTED` with the
//   reason and nothing of the conversation.
//
// Each refusal is decided before any title, subject or message is selected.
// A scope task the reader may not read is decided by the live grants inside
// the statement (`SHOWN`): neither its subject nor a title taken from the
// subject leaves Postgres, and the scope is not returned (catalogue #412). A
// wrap-up's pointers (`contentsForReader`) and the page are served per reader.

import {
  askedFor,
  coveredOwnSitePages,
  EFFECTIVE_GRANTS,
  isUuid,
  readableScope,
  subjectsOf,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type {
  ConversationListResult,
  ConversationMessageView,
  ConversationTargetsView,
  ConversationReadResult,
} from '../../../core-wire/src/index.ts';
import { SITE_PAGE_LIMIT } from '../../../core-wire/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';
import {
  conversationAddress,
  DEFAULT_TITLE,
  holdsOwnConversations,
} from '../commands/conversations.ts';
import { targetsFor } from '../commands/conversation-targets.ts';
import { doorOf, mayRead } from './conversation-door.ts';
import {
  addressReader,
  wrapUpView,
  type ReadsAddress,
  type WrapUpRow,
} from '../commands/conversation-contents.ts';

const COLLECTION = 'conversation';

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

interface MessageRow {
  readonly id: string;
  readonly role: 'person' | 'agent';
  readonly body: string;
  readonly created_at: Date;
}

/** One message as the wire carries it, with the targets kept with it where the reader has them. */
function viewOf(
  message: MessageRow,
  kept: ConversationTargetsView | undefined,
): ConversationMessageView {
  const view = {
    id: message.id,
    role: message.role,
    body: message.body,
    createdAt: message.created_at.toISOString(),
  };
  return kept === undefined ? view : { ...view, targets: kept };
}

/** The body, oldest first; each reply's kept targets only as `targetsFor` gives them to this reader (#1666). */
async function messagesOf(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
): Promise<readonly ConversationMessageView[]> {
  const rows = await tx.query<MessageRow>(
    `select id, role, body, created_at from conversation_messages
      where business_id = $1 and conversation_id = $2
      order by created_at, id`,
    [tx.businessId, conversationId],
  );
  const targets = await targetsFor(
    tx,
    session,
    rows.filter((message) => message.role === 'agent').map((message) => message.id),
  );
  return rows.map((message) => viewOf(message, targets.get(message.id)));
}

/**
 * Whether the reader's subjects ($3 kinds, $4 ids) may read the row's scope
 * task, asked as `task.read` asks of the live grants (`EFFECTIVE_GRANTS`
 * opens the statement) at the statement's own snapshot, so a revocation
 * committed before it is honoured. A title taken from an unreadable task's
 * subject leaves as the default ($5).
 */
const SHOWN = `(conversations.scope_record_id is null or exists (
    select 1 from effective e
     where e.collection = 'task'
       and e.action = 'read'
       and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                    where s.kind = e.subject_kind and s.id = e.subject_id)
       and (e.scope_kind = 'business'
            or (e.scope_kind = 'record' and e.scope_id = conversations.scope_record_id))))`;
const TITLE = `case when ${SHOWN} or title is distinct from subject then title else $5 end as title`;
function reader(session: Session): readonly unknown[] {
  const asked = askedFor(subjectsOf(session), { collection: 'task', action: 'read' });
  return [asked.map((subject) => subject.kind), asked.map((subject) => subject.id), DEFAULT_TITLE];
}

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
  // Before the row: a purge committing between them reads as purged, not as an empty body.
  const body = await messagesOf(tx, session, conversationId);
  const rows = await tx.query<ConversationRow>(
    `${EFFECTIVE_GRANTS}
     select id, ${TITLE}, case when ${SHOWN} then subject end as subject,
            case when ${SHOWN} then scope_kind end as scope_kind,
            case when ${SHOWN} then scope_record_id end as scope_record_id,
            page_address, page_shows, created_at, last_activity_at, body_purged_at
       from conversations where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, ...reader(session)],
  );
  const row = rows[0];
  if (row === undefined) throw new Error('conversation.read: the conversation went between reads');
  const messages = row.body_purged_at === null ? body : null;
  const wrapUps = await tx.query<WrapUpRow>(
    `select version, created_at, written_by_operation, code_revision, definition_version,
            request_quotation, items, left_open
       from conversation_wrap_ups
      where business_id = $1 and conversation_id = $2
      order by version desc`,
    [tx.businessId, conversationId],
  );
  const current = wrapUps[0];
  const reads = addressReader(await readableScope(tx, subjectsOf(session), 'task', 'read'));
  const sitePages = await coveredOwnSitePages(tx, subjectsOf(session), SITE_PAGE_LIMIT);
  return {
    ok: true,
    conversation: conversationView(row, reads),
    messages,
    wrapUp: current === undefined ? null : wrapUpView(current, reads),
    wrapUpHistory: wrapUps.map((wrapUp) => ({
      version: wrapUp.version,
      writtenAt: wrapUp.created_at.toISOString(),
    })),
    ...(sitePages.length === 0 ? {} : { sitePages }),
  };
}

/**
 * Whether the caller holds any conversation grant: `write` (their own) or
 * `read` (the read-any grant) at any scope, a client's included. A caller
 * holding neither is refused before the identifier is looked at, in
 * `checkAuthority`'s words.
 */
async function holdsAConversationGrant(tx: TenantQuery, session: Session): Promise<boolean> {
  const subjects = subjectsOf(session);
  for (const action of ['write', 'read'] as const) {
    const asked = askedFor(subjects, { collection: COLLECTION, action });
    // eslint-disable-next-line no-await-in-loop -- the second is asked only when the first is empty
    const held = await tx.query(
      `${EFFECTIVE_GRANTS}
       select 1 from effective e
        where e.collection = $1 and e.action = $2
          and exists (select 1 from unnest($3::text[], $4::uuid[]) as s (kind, id)
                       where s.kind = e.subject_kind and s.id = e.subject_id)
        limit 1`,
      [COLLECTION, action, asked.map((one) => one.kind), asked.map((one) => one.id)],
    );
    if (held.length > 0) return true;
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
  const door = await doorOf(tx, conversationId);
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
  if (!(await holdsOwnConversations(tx, session))) return HOLDS_NOTHING;
  const rows = await tx.query<
    Pick<ConversationRow, 'id' | 'title' | 'last_activity_at' | 'body_purged_at'>
  >(
    `${EFFECTIVE_GRANTS}
     select id, ${TITLE}, last_activity_at, body_purged_at from conversations
      where business_id = $1 and owner_actor_id = $2
      order by last_activity_at desc, id
      limit ${String(LIST_LIMIT)}`,
    [tx.businessId, session.actorId, ...reader(session)],
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
