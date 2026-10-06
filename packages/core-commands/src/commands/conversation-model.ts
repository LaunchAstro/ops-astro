// SPDX-License-Identifier: AGPL-3.0-only
//
// The model a conversation runs on (CS-7.30, owner answer 7): chosen per
// conversation from only the models offered it, the exact id recorded on
// every call (0098, `model_calls.model_id`).
//
// What is offered is one rule, asked by the picker's read
// (`conversation.models`), by `conversation.set_model` under the
// conversation's row lock, by `conversation.start` on the row it inserts (a
// choice made before the first message), and again by the exchange before any
// call:
//
// - the models this install's conversation operation runs, from the code
//   catalogue (`conversation-models.ts` in core-connectors), the default first;
// - on a conversation opened on a client's task, only those the client's
//   model-egress setting allows (CS-7.40, `checkClientModelUse`): egress off,
//   nothing; a providers list, those providers only, each assessed;
// - on a conversation whose task this session cannot see, nothing, since its
//   client cannot be known.
//
// `conversation.set_model` is the tab row's (`conversation-tabs.ts`); both
// writes keep the choice through `keepModel`.

import {
  conversationModelsOf,
  conversationProviderOf,
  type ConversationModel,
} from '../../../core-connectors/src/index.ts';
import { checkClientModelUse, slotOf, TASK_SPINE } from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { refuseCommand, refuseNotFound, type CommandRefusal } from './refusal.ts';

/** What the offer turns on, from the caller's own conversation row. */
export interface ModelFacts {
  /** The model chosen for it, or null for the default. */
  readonly model: string | null;
  /** The client of the task it was opened on, if any. */
  readonly clientId: string | null;
  /** It was opened on a task this session cannot see. */
  readonly unseen: boolean;
}

const CLIENT = slotOf(TASK_SPINE, 'client');

/** The caller's own conversation's facts, or undefined for anyone else's or none. */
export async function modelFacts(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
): Promise<ModelFacts | undefined> {
  const [found] = await tx.query<{
    readonly model_id: string | null;
    readonly client_id: string | null;
    readonly unseen: boolean;
  }>(
    `select c.model_id, t.${CLIENT}::text as client_id,
            (c.scope_record_id is not null and t.id is null) as unseen
       from conversations c
       left join records t on t.business_id = c.business_id and t.id = c.scope_record_id
      where c.business_id = $1 and c.id = $2 and c.owner_actor_id = $3`,
    [tx.businessId, conversationId, session.actorId],
  );
  if (found === undefined) return undefined;
  return { model: found.model_id, clientId: found.client_id, unseen: found.unseen };
}

/** The models offered on `provider`'s conversation operation: all of them, or the client's allowed. */
export async function offeredModels(
  tx: TenantQuery,
  provider: string,
  facts: ModelFacts | null,
): Promise<readonly ConversationModel[]> {
  const models = conversationModelsOf(provider);
  if (facts === null) return models;
  if (facts.unseen) return [];
  const { clientId } = facts;
  if (clientId === null) return models;
  const offered: ConversationModel[] = [];
  for (const model of models) {
    // oxlint-disable-next-line no-await-in-loop -- one privacy read per model, at most two
    if ((await checkClientModelUse(tx, clientId, model.egressName)).ok) offered.push(model);
  }
  return offered;
}

/** This install's conversation provider, by the composition root's own rule. */
export const installProvider = (): string => conversationProviderOf(process.env);

/** A model not offered, or not a model id: by field name, never echoing what was sent. */
export const MODEL_NOT_OFFERED: CommandRefusal = refuseCommand(
  'FIELD_VALUE_INVALID',
  ['model'],
  [
    'Choose one of the models conversation.models offers for this conversation, or null for the default.',
  ],
);

/**
 * Keeps `model` as the caller's own conversation's choice, if it is offered it
 * (or null, the default), else the refusal, by field name and never echoing
 * it. `conversation.set_model` asks it under the row lock; `conversation.start`
 * asks it on the row it just inserted, before the commit and so before the
 * first exchange reads the choice.
 */
export async function keepModel(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
  model: unknown,
): Promise<CommandRefusal | undefined> {
  if (model !== null && typeof model !== 'string') return MODEL_NOT_OFFERED;
  // What is offered turns on the conversation's own task and client, read here, never the body.
  const facts = await modelFacts(tx, session, conversationId);
  if (facts === undefined) return refuseNotFound();
  const offered = await offeredModels(tx, installProvider(), facts);
  if (model !== null && !offered.some((one) => one.id === model)) return MODEL_NOT_OFFERED;
  await tx.query(`update conversations set model_id = $3 where business_id = $1 and id = $2`, [
    tx.businessId,
    conversationId,
    model,
  ]);
  return undefined;
}

/**
 * The model the exchange asks for, asked again before any call: a choice no
 * longer offered (the client's egress turned off since, or a model this
 * install does not run) is null, and refused. No choice is the default.
 */
async function modelToAsk(
  tx: TenantQuery,
  provider: string,
  facts: ModelFacts,
): Promise<string | undefined | null> {
  if (facts.model === null) return conversationModelsOf(provider)[0]?.id;
  const offered = await offeredModels(tx, provider, facts);
  return offered.some((model) => model.id === facts.model) ? facts.model : null;
}

/** The model the exchange asks for on the caller's own conversation: null for anyone else's. */
export async function askedModel(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
  provider: string,
): Promise<string | undefined | null> {
  const facts = await modelFacts(tx, session, conversationId);
  return facts === undefined ? null : await modelToAsk(tx, provider, facts);
}
