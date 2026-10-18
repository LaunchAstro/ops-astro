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
// - on a conversation on a client's task (its stored page's task, else the one
//   it opened on: `conversation-page-task.ts`), only those the client's
//   model-egress setting allows (CS-7.40, `checkClientModelUse`): egress off,
//   nothing; a providers list, those providers only, each assessed; a model
//   no setting names (Ollama's) never, so it serves internal work only;
// - on a conversation whose task this session cannot see (gone, or its read
//   grant revoked since the conversation was opened), nothing, so the offer
//   tells nothing of its client, and a model chosen for it is refused;
// - OpenRouter's paid models (#1508) besides, only to a person on the outside
//   people list for this business (`OPS_OUTSIDE_MODEL_PEOPLE`), and only on a
//   conversation with no client page. Never the default.
//
// `conversation.set_model` is the tab row's (`conversation-tabs.ts`); both
// writes keep the choice through `keepModel`.

import {
  conversationModelsOf,
  conversationProviderOf,
  OPENROUTER_PROVIDER,
  outsidePeopleOf,
  type ConversationModel,
} from '../../../core-connectors/src/index.ts';
import {
  checkAuthority,
  checkClientModelUse,
  slotOf,
  subjectsOf,
  TASK_SPINE,
} from '../../../core-records/src/index.ts';
import type { Session, TenantQuery } from '../../../core-records/src/index.ts';
import { pageTaskOf } from './conversation-page-task.ts';
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

/** The caller may still read the task: the records policies do not hold task grants. */
export async function readsTask(
  tx: TenantQuery,
  session: Session,
  id: string | null,
): Promise<boolean> {
  if (id === null) return true;
  const read = { collection: 'task', action: 'read', scope: { kind: 'record', id } } as const;
  return (await checkAuthority(tx, subjectsOf(session), read)).ok;
}

/** The caller's own conversation's facts, or undefined for anyone else's or none. */
export async function modelFacts(
  tx: TenantQuery,
  session: Session,
  conversationId: string,
): Promise<ModelFacts | undefined> {
  const [found] = await tx.query<{
    readonly model_id: string | null;
    readonly scope_record_id: string | null;
    readonly page_address: string | null;
  }>(
    `select model_id, scope_record_id, page_address from conversations
      where business_id = $1 and id = $2 and owner_actor_id = $3`,
    [tx.businessId, conversationId, session.actorId],
  );
  if (found === undefined) return undefined;
  // The task the exchange judges: the stored page's, else the one it opened on (S1930-1).
  const task = await pageTaskOf(tx, found.scope_record_id, found.page_address);
  const [row] =
    task === null
      ? []
      : await tx.query<{ readonly client_id: string | null }>(
          `select ${CLIENT}::text as client_id from records where business_id = $1 and id = $2`,
          [tx.businessId, task],
        );
  // Asked as the exchange asks it: a task gone, or one this session may no longer read, is unseen.
  const unseen = (task !== null && row === undefined) || !(await readsTask(tx, session, task));
  return { model: found.model_id, clientId: row?.client_id ?? null, unseen };
}

/** Whether the caller is on this install's outside people list for this business (#1508). */
export const outsideListed = (tx: TenantQuery, session: Session): boolean =>
  outsidePeopleOf(process.env).includes(`${tx.businessId}:${session.personId}`.toLowerCase());

/**
 * The models offered on `provider`'s conversation operation, with the paid
 * ones for a listed person (`outside`): all of them, or the client's allowed.
 * A paid model names no client setting, so a client's conversation never gets one.
 */
export async function offeredModels(
  tx: TenantQuery,
  provider: string,
  facts: ModelFacts | null,
  outside = false,
): Promise<readonly ConversationModel[]> {
  const models = [
    ...conversationModelsOf(provider),
    ...(outside ? conversationModelsOf(OPENROUTER_PROVIDER) : []),
  ];
  if (facts === null) return models;
  if (facts.unseen) return [];
  const { clientId } = facts;
  if (clientId === null) return models;
  const offered: ConversationModel[] = [];
  for (const model of models) {
    // A model no client's setting can name is for internal work only.
    if (model.egressName === null) continue;
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
  const offered = await offeredModels(tx, installProvider(), facts, outsideListed(tx, session));
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
  outside: boolean,
): Promise<string | undefined | null> {
  if (facts.model === null) return conversationModelsOf(provider)[0]?.id;
  const offered = await offeredModels(tx, provider, facts, outside);
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
  if (facts === undefined) return null;
  return await modelToAsk(tx, provider, facts, outsideListed(tx, session));
}
