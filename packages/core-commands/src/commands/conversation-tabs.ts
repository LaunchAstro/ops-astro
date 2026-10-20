// SPDX-License-Identifier: AGPL-3.0-only
//
// The assistant panel's tab row (MP-7-11): renaming a conversation (CS-7.32)
// and "Add page to context" (CS-7.31), its owner's alone like every other
// write to it (AW-03).
//
// CS-7.30 adds the model it runs on, from those offered it
// (`conversation-model.ts`): a model not offered is refused by field name,
// never echoing what was sent, and null is the default again.
//
// The page is one slot: a second pointer replaces the first, and `null`
// clears it. Its address is a page of this product: one leading slash, never
// two and never a slash then a backslash, printable ASCII without a
// backslash, at most 300 characters. Migration 0094 refuses the same rows, as
// the backstop. Neither write is activity: the wrap-up at quiet and the purge
// window measure the exchange, not the tab's label or its pointer.
//
// The answer names the conversation and its address only. The register
// stores the answer and the audit event the payload's digest, so the title
// and the page are kept on the conversation and nowhere else.

import { subjectsOf, type TenantQuery } from '../../../core-records/src/index.ts';
import { checkAuthorityAt, lockedInstant } from '../../../core-runtime/src/index.ts';
import type { CommandContext } from './context.ts';
import {
  bounded,
  conversationAddress,
  NOT_YOURS,
  OWN_WRITE,
  PURGED,
  TITLE_LIMIT,
} from './conversations.ts';
import { followModel } from './conversation-agents.ts';
import { PAGE_INVALID, pageOf } from './conversation-page.ts';
import { keepModel, MODEL_NOT_OFFERED } from './conversation-model.ts';
import { isIdentifier } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';

/**
 * The caller's own conversation, locked: the row lock `conversation.message`,
 * the wrap-up and the purge take, so a pointer never lands on a body being
 * purged. Another business's and a made-up id are the same `NOT_FOUND`. The
 * grant the door asked is asked again at the clock after the lock, as
 * `conversation.message` asks it: one that lapsed while this waited no longer
 * counts.
 */
export async function ownedForUpdate(
  tx: TenantQuery,
  context: CommandContext,
  conversationId: unknown,
): Promise<CommandRefusal | undefined> {
  if (!isIdentifier(conversationId)) return refuseNotFound();
  const rows = await tx.query<{
    readonly owner_actor_id: string;
    readonly body_purged_at: Date | null;
  }>(
    `select owner_actor_id, body_purged_at from conversations
      where business_id = $1 and id = $2
      for update`,
    [tx.businessId, conversationId],
  );
  const conversation = rows[0];
  if (conversation === undefined) return refuseNotFound();
  if (conversation.owner_actor_id !== context.session.actorId) return NOT_YOURS;
  if (conversation.body_purged_at !== null) return PURGED;
  const still = await checkAuthorityAt(
    tx,
    subjectsOf(context.session),
    OWN_WRITE,
    await lockedInstant(tx),
  );
  return still.ok ? undefined : still.refusal;
}

export interface RenameFields {
  readonly conversationId: unknown;
  readonly title: unknown;
}

export async function renameConversation(
  tx: TenantQuery,
  context: CommandContext,
  fields: RenameFields,
): Promise<HandlerOutcome> {
  if (!bounded(fields.title, TITLE_LIMIT)) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['title'],
        [`Send the title as 1 to ${String(TITLE_LIMIT)} characters.`],
      ),
    );
  }
  const refusal = await ownedForUpdate(tx, context, fields.conversationId);
  if (refusal !== undefined) return refused(refusal);
  const conversationId = fields.conversationId as string;
  await tx.query(`update conversations set title = $3 where business_id = $1 and id = $2`, [
    tx.businessId,
    conversationId,
    fields.title.trim(),
  ]);
  return applied(null, null, { conversationId, address: conversationAddress(conversationId) });
}

export interface ScopeFields {
  readonly conversationId: unknown;
  readonly page: unknown;
}

export async function setConversationScope(
  tx: TenantQuery,
  context: CommandContext,
  fields: ScopeFields,
): Promise<HandlerOutcome> {
  const page = pageOf(fields.page);
  if (page === undefined) return refused(PAGE_INVALID);
  const refusal = await ownedForUpdate(tx, context, fields.conversationId);
  if (refusal !== undefined) return refused(refusal);
  const conversationId = fields.conversationId as string;
  await tx.query(
    `update conversations set page_address = $3, page_shows = $4
      where business_id = $1 and id = $2`,
    [tx.businessId, conversationId, page?.address ?? null, page?.shows.trim() ?? null],
  );
  return applied(null, null, { conversationId, address: conversationAddress(conversationId) });
}

export interface ModelFields {
  readonly conversationId: unknown;
  readonly model: unknown;
}

/** `conversation.set_model`: the conversation's model, from those offered it, or null for the default. */
export async function setModel(
  tx: TenantQuery,
  context: CommandContext,
  fields: ModelFields,
): Promise<HandlerOutcome> {
  if (fields.model !== null && typeof fields.model !== 'string') return refused(MODEL_NOT_OFFERED);
  const refusal = await ownedForUpdate(tx, context, fields.conversationId);
  if (refusal !== undefined) return refused(refusal);
  const conversationId = fields.conversationId as string;
  // Asked under the row lock, after the owner check.
  const notKept = await keepModel(tx, context.session, conversationId, fields.model);
  if (notKept !== undefined) return refused(notKept);
  // The deployment's model agent joins on a model it carries, and leaves on one it does not (#1531).
  await followModel(tx, context, conversationId, fields.model);
  return applied(null, null, { conversationId, address: conversationAddress(conversationId) });
}
