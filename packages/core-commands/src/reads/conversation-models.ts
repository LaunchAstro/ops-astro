// SPDX-License-Identifier: AGPL-3.0-only
//
// `conversation.models` (CS-7.30): the models the drawer's picker offers, each
// with its price-book entry, and the conversation's own choice.
//
// Who may read it is the tab row's rule: a member holding `conversation:write`,
// the owner's key; a client and a caller with no membership hold no drawer
// (`NOT_FOUND`, as `conversation.read` answers them) and a member without the
// key is `SCOPE_NOT_GRANTED`, before anything is read. The conversation is
// optional: none is the empty drawer, offered this install's models; one that
// is named must be the caller's own in this business, and anything else
// (another person's, another business's, a made-up id) is `NOT_FOUND`, the same
// bytes for each. The offer itself is `offeredModels`, the one rule the write
// and the exchange ask too (`commands/conversation-model.ts`).

import { isUuid } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import type { ConversationModel } from '../../../core-connectors/src/index.ts';
import type { ConversationModelsResult } from '../../../core-wire/src/index.ts';
import { installProvider, modelFacts, offeredModels } from '../commands/conversation-model.ts';
import { holdsOwnConversations } from '../commands/conversations.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';

const HOLDS_NOTHING = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

const viewOf = ({ id, provider, reach, ceilingMinor }: ConversationModel) => ({
  id,
  provider,
  reach,
  ceilingMinor,
});

export async function readConversationModels(
  tx: TenantQuery,
  session: Session,
  conversationId: unknown,
): Promise<ConversationModelsResult | CommandRefusal> {
  if (session.roleKey === null) return refuseNotFound();
  if (!(await holdsOwnConversations(tx, session))) return HOLDS_NOTHING;
  const provider = installProvider();
  if (conversationId === undefined || conversationId === null) {
    const models = await offeredModels(tx, provider, null);
    return { ok: true, models: models.map((model) => viewOf(model)), chosen: null };
  }
  if (!isUuid(conversationId)) {
    return refuseCommand(
      'FIELD_VALUE_INVALID',
      ['conversationId'],
      ['Send conversationId as your conversation’s identifier, or leave it out.'],
    );
  }
  const facts = await modelFacts(tx, session, conversationId);
  if (facts === undefined) return refuseNotFound();
  const models = await offeredModels(tx, provider, facts);
  return { ok: true, models: models.map((model) => viewOf(model)), chosen: facts.model };
}
