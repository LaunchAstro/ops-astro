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
//
// On an install that answers on Ollama, the owner's ChatGPT plan's models
// (#2175) not offered to this caller are listed apart as unavailable, each
// with why: the plan's route is not set here, the caller is not the owner, or
// the plan refused the model for this account. A conversation on a client's
// task, or one whose task this session cannot see, lists none of them.

import { isUuid } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import {
  CHATGPT_PLAN_PROVIDER,
  conversationModelsOf,
  OLLAMA_PROVIDER,
  type ConversationModel,
} from '../../../core-connectors/src/index.ts';
import type {
  ConversationModelsResult,
  ConversationModelUnavailableView,
} from '../../../core-wire/src/index.ts';
import {
  installProvider,
  modelFacts,
  offeredModels,
  outsideListed,
  planStanding,
  refusedPlanModels,
  type ModelFacts,
} from '../commands/conversation-model.ts';
import { holdsOwnConversations } from '../commands/conversations.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from '../commands/refusal.ts';

const HOLDS_NOTHING = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

const viewOf = ({ id, provider, reach, ceilingMinor, label }: ConversationModel) => ({
  id,
  provider,
  reach,
  ceilingMinor,
  ...(label === undefined ? {} : { label }),
});

/** Why a plan model is shown but not offered, in the picker's words. */
const UNAVAILABLE: Readonly<Record<string, string>> = {
  PLAN_ROUTE_NOT_SET: 'The ChatGPT plan is not connected here.',
  SUBSCRIPTION_NOT_OWNER_STARTED:
    'This model runs on the owner’s ChatGPT plan, for the owner only.',
  SUBSCRIPTION_NOT_ELIGIBLE: 'The ChatGPT plan refused this model for this account.',
};

/** The plan models not offered, each with why; none off Ollama or on a client's or unseen task. */
async function unavailableOf(
  tx: TenantQuery,
  session: Session,
  facts: ModelFacts | null,
  offered: readonly ConversationModel[],
): Promise<readonly ConversationModelUnavailableView[]> {
  if (installProvider() !== OLLAMA_PROVIDER) return [];
  if (facts !== null && (facts.unseen || facts.clientId !== null)) return [];
  const standing = planStanding(session);
  const refused = standing === undefined ? await refusedPlanModels(tx) : new Set<string>();
  return conversationModelsOf(CHATGPT_PLAN_PROVIDER).flatMap((model) => {
    if (offered.some((one) => one.id === model.id)) return [];
    const code = standing ?? (refused.has(model.id) ? 'SUBSCRIPTION_NOT_ELIGIBLE' : undefined);
    if (code === undefined) return [];
    const { id, provider, label } = model;
    const words = UNAVAILABLE[code] ?? '';
    return [{ id, provider, ...(label === undefined ? {} : { label }), code, words }];
  });
}

/** The answer: the offered models, any shown unavailable, and the conversation's choice. */
async function answerOf(
  tx: TenantQuery,
  session: Session,
  facts: ModelFacts | null,
): Promise<ConversationModelsResult> {
  const plan = planStanding(session) === undefined;
  const models = await offeredModels(
    tx,
    installProvider(),
    facts,
    outsideListed(tx, session),
    plan,
  );
  const unavailable = await unavailableOf(tx, session, facts, models);
  return {
    ok: true,
    models: models.map((model) => viewOf(model)),
    ...(unavailable.length === 0 ? {} : { unavailable }),
    chosen: facts?.model ?? null,
  };
}

export async function readConversationModels(
  tx: TenantQuery,
  session: Session,
  conversationId: unknown,
): Promise<ConversationModelsResult | CommandRefusal> {
  if (session.roleKey === null) return refuseNotFound();
  if (!(await holdsOwnConversations(tx, session))) return HOLDS_NOTHING;
  if (conversationId === undefined || conversationId === null) {
    return await answerOf(tx, session, null);
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
  return await answerOf(tx, session, facts);
}
