// SPDX-License-Identifier: AGPL-3.0-only
//
// A person's conversation with the agent (AW-03), its two writes.
//
// `conversation.start` is the first message: the conversation's identity is
// minted with it, so opening and closing the drawer without sending anything
// writes no row. `conversation.message` adds its owner's next message and
// moves the conversation's last activity, which is what the wrap-up at quiet
// and the purge window are measured from. The owner is the verified session,
// never the body, and a conversation is its owner's alone: anyone else is
// refused `SCOPE_NOT_GRANTED` whatever grants they hold, because the read-any
// grant reads and never writes.
//
// The message text is stored and nowhere else: the answer carries the ids
// and the address, the register stores that answer, and the audit event
// carries the payload's digest only.

import { randomUUID } from 'node:crypto';
import { checkAuthority, subjectsOf } from '../../../core-records/src/index.ts';
import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { isIdentifier } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';

const BODY_LIMIT = 20_000;
const TITLE_LIMIT = 120;
const SUBJECT_LIMIT = 200;
const DEFAULT_TITLE = 'New conversation';

/** The conversation's address: the page C36 draws, and the API's read of it. */
export const conversationAddress = (conversationId: string): string => `/agent/${conversationId}`;

const bounded = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= limit;

const optionalBounded = (value: unknown, limit: number): boolean =>
  value === undefined || value === null || bounded(value, limit);

interface Scope {
  readonly kind: 'task';
  readonly id: string;
}

function scopeOf(value: unknown): Scope | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { kind, id, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || kind !== 'task' || !isIdentifier(id)) return undefined;
  return { kind, id };
}

export interface StartFields {
  readonly body: unknown;
  readonly title?: unknown;
  readonly subject?: unknown;
  readonly scope?: unknown;
}

/**
 * The cited task, if the caller may read it. A task that is not there, is in
 * the trash, or is not the caller's to read is one answer, `NOT_FOUND`, so
 * citing a task tells the caller nothing they could not already read.
 */
async function citable(tx: TenantQuery, context: CommandContext, scope: Scope): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select id from records
      where business_id = $1 and id = $2 and record_type_id = $3 and deleted_at is null`,
    [tx.businessId, scope.id, context.spine.taskTypeId],
  );
  if (rows.length === 0) return false;
  const readable = await checkAuthority(tx, subjectsOf(context.session), {
    collection: 'task',
    action: 'read',
    scope: { kind: 'record', id: scope.id },
  });
  return readable.ok;
}

export async function startConversation(
  tx: TenantQuery,
  context: CommandContext,
  fields: StartFields,
): Promise<HandlerOutcome> {
  const scope = scopeOf(fields.scope);
  const invalid = [
    ...(bounded(fields.body, BODY_LIMIT) ? [] : ['body']),
    ...(optionalBounded(fields.title, TITLE_LIMIT) ? [] : ['title']),
    ...(optionalBounded(fields.subject, SUBJECT_LIMIT) ? [] : ['subject']),
    ...(scope === undefined ? ['scope'] : []),
  ];
  if (invalid.length > 0) {
    return refused(
      refuseCommand('FIELD_VALUE_INVALID', invalid, [
        `Send the first message as body, 1 to ${BODY_LIMIT} characters; a title of at most ${TITLE_LIMIT} and a subject of at most ${SUBJECT_LIMIT} if any; and a scope as {"kind":"task","id":<task id>} or nothing.`,
      ]),
    );
  }
  if (scope && !(await citable(tx, context, scope))) return refused(refuseNotFound(['scope']));
  const { session } = context;
  const subject = typeof fields.subject === 'string' ? fields.subject.trim() : null;
  const title = typeof fields.title === 'string' ? fields.title.trim() : (subject ?? DEFAULT_TITLE);
  const conversationId = randomUUID();
  const messageId = randomUUID();
  await tx.query(
    `insert into conversations
       (business_id, id, owner_actor_id, owner_person_id, title, subject, scope_kind,
        scope_record_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      tx.businessId,
      conversationId,
      session.actorId,
      session.personId,
      title,
      subject,
      scope?.kind ?? null,
      scope?.id ?? null,
    ],
  );
  await tx.query(
    `insert into conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body)
     values ($1, $2, $3, 'person', $4, $5)`,
    [tx.businessId, messageId, conversationId, session.actorId, fields.body],
  );
  return applied(null, null, {
    conversationId,
    messageId,
    address: conversationAddress(conversationId),
  });
}

export interface MessageFields {
  readonly conversationId: unknown;
  readonly body: unknown;
}

const NOT_YOURS = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  [
    'A conversation is its owner’s alone; only its owner adds to it.',
    'Start a conversation of your own.',
  ],
);

const PURGED = refuseCommand(
  'TRANSITION_NOT_PERMITTED',
  [],
  [
    'This conversation’s messages have been purged; its address shows the wrap-up.',
    'Start a new conversation, citing this one’s address.',
  ],
);

export async function messageConversation(
  tx: TenantQuery,
  context: CommandContext,
  fields: MessageFields,
): Promise<HandlerOutcome> {
  if (!bounded(fields.body, BODY_LIMIT)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['body'],
        [`Send the message as body, 1 to ${BODY_LIMIT} characters.`],
      ),
    );
  }
  if (!isIdentifier(fields.conversationId)) return refused(refuseNotFound());
  // The row lock orders this message against the wrap-up and the purge, which
  // take the same lock: a message never lands in a body being purged.
  const rows = await tx.query<{
    readonly owner_actor_id: string;
    readonly body_purged_at: Date | null;
  }>(
    `select owner_actor_id, body_purged_at from conversations
      where business_id = $1 and id = $2
      for update`,
    [tx.businessId, fields.conversationId],
  );
  const conversation = rows[0];
  if (conversation === undefined) return refused(refuseNotFound());
  if (conversation.owner_actor_id !== context.session.actorId) return refused(NOT_YOURS);
  if (conversation.body_purged_at !== null) return refused(PURGED);
  const messageId = randomUUID();
  await tx.query(
    `insert into conversation_messages
       (business_id, id, conversation_id, role, author_actor_id, body)
     values ($1, $2, $3, 'person', $4, $5)`,
    [tx.businessId, messageId, fields.conversationId, context.session.actorId, fields.body],
  );
  await tx.query(
    `update conversations set last_activity_at = greatest(now(), last_activity_at)
      where business_id = $1 and id = $2`,
    [tx.businessId, fields.conversationId],
  );
  return applied(null, null, {
    conversationId: fields.conversationId,
    messageId,
    address: conversationAddress(fields.conversationId),
  });
}
