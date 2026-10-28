// SPDX-License-Identifier: AGPL-3.0-only
//
// The models a conversation may run on (CS-7.30, AI-02's picker), registered
// here in code and reviewed, never configured, as the operations are. Each is
// an exact model id, the provider whose adapter sends it, the reach of that
// provider's route, the name a client's model-egress setting gives that
// provider (CS-7.40, `MODEL_PROVIDERS`), and its price-book entry: the
// per-call ceiling in AUD minor units, its conversation operation's priced
// maximum.
//
// Only a model the server can vouch for is listed: the replay stand-in's one
// model, the laptop runner's default, and the models Ollama runs on the M5. A
// model the owner approves on the laptop is the runner's own business
// (`apps/local-agent/gate.ts`), so it is never offered here. OpenRouter's paid
// models (#1508) are listed for their provider, and offered only to a person
// on the outside people list in a conversation with no client page; never the
// default. The owner's ChatGPT plan's models (#2175) are the route's own admit
// list (`CHATGPT_PLAN_MODELS`, which the M5 checks a plan call against),
// offered only to the owner where the carried deployment has the plan's route.
// Hermes Agent (#2270), the owner's own agent on the M5, is listed for its
// provider and offered only to a person `OPS_HERMES_PEOPLE` lists.

import { HERMES_CONVERSATION_KEY, HERMES_MODEL, HERMES_PROVIDER } from './hermes.ts';
import {
  CHATGPT_PLAN_CONVERSATION,
  CHATGPT_PLAN_MODELS,
  CHATGPT_PLAN_PROVIDER,
} from './chatgpt-plan.ts';
import {
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_DEFAULT_MODEL,
  LOCAL_GPT_PROVIDER,
} from './local-gpt.ts';
import { OLLAMA_CONVERSATION, OLLAMA_MODELS, OLLAMA_PROVIDER } from './ollama.ts';
import {
  OPENROUTER_CONVERSATION_KEY,
  OPENROUTER_MODELS,
  OPENROUTER_PROVIDER,
  openrouterHoldMinor,
} from './openrouter.ts';
import { CONVERSATION_ANSWER, REPLAY_MODEL_WINDOW } from './replay.ts';

export interface ConversationModel {
  readonly id: string;
  readonly provider: string;
  readonly reach: 'local' | 'cloud';
  /**
   * The provider's name in a client's privacy settings; null for one no setting
   * names yet, which no client's conversation is offered (internal work only).
   */
  readonly egressName: 'replay' | 'chatgpt' | null;
  /** The price-book entry: the most one call may cost, in AUD minor units. */
  readonly ceilingMinor: number;
  /** The picker's words, where they are not the id. */
  readonly label?: string;
}

export const CONVERSATION_MODELS: readonly ConversationModel[] = [
  {
    id: REPLAY_MODEL_WINDOW.model,
    provider: CONVERSATION_ANSWER.provider,
    reach: 'local',
    egressName: 'replay',
    ceilingMinor: CONVERSATION_ANSWER.maximumMinor,
  },
  {
    id: LOCAL_GPT_DEFAULT_MODEL,
    provider: LOCAL_GPT_PROVIDER,
    // GPT is a cloud model wherever its runner listens (`model-broker.ts`).
    reach: 'cloud',
    egressName: 'chatgpt',
    ceilingMinor: LOCAL_GPT_CONVERSATION.maximumMinor,
  },
  ...OLLAMA_MODELS.map((id): ConversationModel => ({
    id,
    provider: OLLAMA_PROVIDER,
    reach: 'local',
    egressName: null,
    ceilingMinor: OLLAMA_CONVERSATION.maximumMinor,
  })),
  ...OPENROUTER_MODELS.map((model): ConversationModel => ({
    id: model.id,
    provider: OPENROUTER_PROVIDER,
    reach: 'cloud',
    egressName: null,
    ceilingMinor: openrouterHoldMinor(model),
    label: model.label,
  })),
  // Named by no client's setting, so never offered on a client's conversation.
  ...CHATGPT_PLAN_MODELS.map((id): ConversationModel => ({
    id,
    provider: CHATGPT_PLAN_PROVIDER,
    reach: 'cloud',
    egressName: null,
    ceilingMinor: CHATGPT_PLAN_CONVERSATION.maximumMinor,
    label: `${id} (your ChatGPT plan)`,
  })),
  {
    id: HERMES_MODEL,
    provider: HERMES_PROVIDER,
    // Custody calls it on the M5's loopback; it is offered only to its listed people.
    reach: 'local',
    egressName: null,
    ceilingMinor: 0,
    label: 'Hermes Agent',
  },
];

/** The conversation operation a provider's models answer on: OpenRouter's, the plan's and Hermes Agent's own, else the install's. */
export function conversationOperationOf(provider: string): string {
  if (provider === OPENROUTER_PROVIDER) return OPENROUTER_CONVERSATION_KEY;
  if (provider === HERMES_PROVIDER) return HERMES_CONVERSATION_KEY;
  return provider === CHATGPT_PLAN_PROVIDER
    ? CHATGPT_PLAN_CONVERSATION.key
    : CONVERSATION_ANSWER.key;
}

/**
 * Whether the carried deployment has the owner's plan route (#2091): the
 * install answers on Ollama, `MODEL_BROKER_CARRIER` is set, and a route of
 * `MODEL_BROKER_ROUTES` is the plan's. The API's composition root refuses to
 * start on a malformed setting, so this reads only the provider of each.
 */
export function planRouteSet(environment: Readonly<Record<string, string | undefined>>): boolean {
  if (environment['OPS_AGENT_PROVIDER'] !== 'ollama') return false;
  if ((environment['MODEL_BROKER_CARRIER'] ?? '') === '') return false;
  let routes: unknown;
  try {
    routes = JSON.parse(environment['MODEL_BROKER_ROUTES'] ?? '');
  } catch {
    return false;
  }
  return (
    Array.isArray(routes) &&
    routes.some(
      (route: unknown) =>
        typeof route === 'object' &&
        route !== null &&
        (route as Record<string, unknown>)['provider'] === CHATGPT_PLAN_PROVIDER,
    )
  );
}

/**
 * `OPS_OUTSIDE_MODEL_PEOPLE` as `businessId:personId` pairs, lower case, when
 * `OPS_OUTSIDE_PROVIDER` is `openrouter`; otherwise nobody. The API's
 * composition root refuses to start on a malformed list, so this never sees one.
 */
export function outsidePeopleOf(
  environment: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  if (environment['OPS_OUTSIDE_PROVIDER'] !== OPENROUTER_PROVIDER) return [];
  return (environment['OPS_OUTSIDE_MODEL_PEOPLE'] ?? '')
    .split(',')
    .map((pair) => pair.trim().toLowerCase())
    .filter((pair) => pair !== '');
}

/** The models one provider's conversation operation runs, its default first. */
export const conversationModelsOf = (provider: string): readonly ConversationModel[] =>
  CONVERSATION_MODELS.filter((model) => model.provider === provider);

/**
 * The provider this install's conversation operation is on, by the rule the
 * API's composition root applies (`apps/api/model-broker.ts`): `ollama` in
 * any environment, `local-gpt` only where `OPS_ENVIRONMENT` is `local`, the
 * replay provider otherwise. A setting the root refuses never serves a
 * request, so this never has to.
 */
export function conversationProviderOf(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const named = environment['OPS_AGENT_PROVIDER'];
  if (named === 'ollama') return OLLAMA_PROVIDER;
  return named === 'local-gpt' && environment['OPS_ENVIRONMENT'] === 'local'
    ? LOCAL_GPT_PROVIDER
    : CONVERSATION_ANSWER.provider;
}
