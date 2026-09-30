// SPDX-License-Identifier: AGPL-3.0-only
//
// The assistant panel's tab row (MP-7-11): renaming a conversation (CS-7.32)
// and "Add page to context" (CS-7.31), its owner's alone like every other
// write to it (AW-03).
//
// The page is one slot: a second pointer replaces the first, and `null`
// clears it. Its address is a page of this product: one leading slash, never
// two and never a slash then a backslash, printable ASCII without a
// backslash, at most 300 characters. Migration 0051 refuses the same rows, as
// the backstop. Neither write is activity: the wrap-up at quiet and the purge
// window measure the exchange, not the tab's label or its pointer.
//
// The answer names the conversation and its address only. The register
// stores the answer and the audit event the payload's digest, so the title
// and the page are kept on the conversation and nowhere else.

import type { TenantQuery } from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { bounded, conversationAddress, NOT_YOURS, PURGED, TITLE_LIMIT } from './conversations.ts';
import { isIdentifier } from './operands.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';

const ADDRESS_LIMIT = 300;
const SHOWS_LIMIT = 200;
const IN_PRODUCT = /^\/(?![/\\])[!-~]*$/u;
// eslint-disable-next-line no-control-regex -- the control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u;

interface Page {
  readonly address: string;
  readonly shows: string;
}

const isAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ADDRESS_LIMIT &&
  IN_PRODUCT.test(value) &&
  !value.includes('\\');

const isShows = (value: unknown): value is string =>
  bounded(value, SHOWS_LIMIT) && !CONTROL.test(value);

/** The page, `null` to clear it, or undefined when it will not do. */
function pageOf(value: unknown): Page | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || value === undefined || Array.isArray(value)) return undefined;
  const { address, shows, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isAddress(address) || !isShows(shows)) return undefined;
  return { address, shows };
}

/**
 * The caller's own conversation, locked: the row lock `conversation.message`,
 * the wrap-up and the purge take, so a pointer never lands on a body being
 * purged. Another business's and a made-up id are the same `NOT_FOUND`.
 */
async function ownedForUpdate(
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
  return undefined;
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
  if (page === undefined) {
    return refused(
      refuseCommand(
        'FIELD_VALUE_INVALID',
        ['page'],
        [
          `Send page as {"address":<a path of this product, starting with one slash, at most ${String(ADDRESS_LIMIT)} printable characters>,"shows":<what the page shows, 1 to ${String(SHOWS_LIMIT)} characters>}, or null to clear it.`,
        ],
      ),
    );
  }
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
