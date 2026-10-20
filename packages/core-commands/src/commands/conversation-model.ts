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
//   nothing; a providers list, those providers only, each assessed; a model
//   no setting names (Ollama's) never, so it serves internal work only;
// - on a conversation whose task this session cannot see (gone, or its read
//   grant revoked since the conversation was opened), nothing, so the offer
//   tells nothing of its client, and a model chosen for it is refused;
// - OpenRouter's paid models (#1508) besides, only to a person on the outside
//   people list for this business (`OPS_OUTSIDE_MODEL_PEOPLE`), and only on a
//   conversation with no client page. Never the default.
// - The owner's ChatGPT plan's models (#2175, money rule P4) besides, only to
//   a session holding the owner role, only where the carried deployment has
//   the plan's route (`planRouteSet`), and only on a conversation with no
//   client page. Never the default. A plan model whose latest call the plan
//   refused for this account (`http_403`) is not offered: the picker shows it
//   unavailable with that reason until a code change says otherwise.
//
// `conversation.set_model` is the tab row's (`conversation-tabs.ts`); both
// writes keep the choice through `keepModel`.

import {
  CHATGPT_PLAN_PROVIDER,
  conversationModelsOf,
  conversationProviderOf,
  OLLAMA_PROVIDER,
  OPENROUTER_PROVIDER,
  outsidePeopleOf,
  planRouteSet,
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
    readonly client_id: string | null;
    readonly scope_record_id: string | null;
    readonly unseen: boolean;
  }>(
    `select c.model_id, t.${CLIENT}::text as client_id, c.scope_record_id,
            (c.scope_record_id is not null and t.id is null) as unseen
       from conversations c
       left join records t on t.business_id = c.business_id and t.id = c.scope_record_id
      where c.business_id = $1 and c.id = $2 and c.owner_actor_id = $3`,
    [tx.businessId, conversationId, session.actorId],
  );
  if (found === undefined) return undefined;
  // Asked as the exchange asks it: a task this session may no longer read is unseen.
  const unseen = found.unseen || !(await readsTask(tx, session, found.scope_record_id));
  return { model: found.model_id, clientId: found.client_id, unseen };
}

/** Whether the caller is on this install's outside people list for this business (#1508). */
export const outsideListed = (tx: TenantQuery, session: Session): boolean =>
  outsidePeopleOf(process.env).includes(`${tx.businessId}:${session.personId}`.toLowerCase());

/** Why a plan model is not offered to this caller, or undefined when it may be. */
export type PlanStanding = 'PLAN_ROUTE_NOT_SET' | 'SUBSCRIPTION_NOT_OWNER_STARTED' | undefined;

/** The plan's standing for this caller: the carried plan route, and the owner role held. */
export const planStanding = (session: Session): PlanStanding => {
  if (!planRouteSet(process.env)) return 'PLAN_ROUTE_NOT_SET';
  return session.roleKey === 'owner' ? undefined : 'SUBSCRIPTION_NOT_OWNER_STARTED';
};

/** The plan models whose latest call the plan refused for this account: `http_403`. */
export async function refusedPlanModels(tx: TenantQuery): Promise<ReadonlySet<string>> {
  const rows = await tx.query<{ readonly model_id: string }>(
    `select model_id from (
       select distinct on (model_id) model_id, provider_code
         from public.model_calls
        where business_id = $1 and provider = $2 and model_id is not null
          and state in ('settled', 'liability_unknown')
        order by model_id, started_at desc) latest
      where provider_code = 'http_403'`,
    [tx.businessId, CHATGPT_PLAN_PROVIDER],
  );
  return new Set(rows.map((row) => row.model_id));
}

/**
 * The models offered on `provider`'s conversation operation, with the paid
 * ones for a listed person (`outside`) and the plan's for the owner (`plan`):
 * all of them, or the client's allowed. A paid or plan model names no client
 * setting, so a client's conversation never gets one.
 */
export async function offeredModels(
  tx: TenantQuery,
  provider: string,
  facts: ModelFacts | null,
  outside = false,
  plan = false,
): Promise<readonly ConversationModel[]> {
  const refused = plan ? await refusedPlanModels(tx) : new Set<string>();
  const models = [
    ...conversationModelsOf(provider),
    ...(outside ? conversationModelsOf(OPENROUTER_PROVIDER) : []),
    ...(plan ? conversationModelsOf(CHATGPT_PLAN_PROVIDER) : []).filter(
      (model) => !refused.has(model.id),
    ),
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
  const offered = await offeredModels(
    tx,
    installProvider(),
    facts,
    outsideListed(tx, session),
    planStanding(session) === undefined,
  );
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
  admitted: { readonly outside: boolean; readonly plan: boolean },
): Promise<string | undefined | null> {
  if (facts.model === null) return conversationModelsOf(provider)[0]?.id;
  const offered = await offeredModels(tx, provider, facts, admitted.outside, admitted.plan);
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
  return await modelToAsk(tx, provider, facts, {
    outside: outsideListed(tx, session),
    plan: provider === OLLAMA_PROVIDER && planStanding(session) === undefined,
  });
}
