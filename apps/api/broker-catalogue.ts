// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations and their adapters, per provider, as the API's composition
// root registers them (AW-01): in code and reviewed, never configured. The
// outside provider (#1508) adds OpenRouter's paid conversation operation and
// its adapter beside any of them, only where `OPS_OUTSIDE_PROVIDER` is
// `openrouter` (`outside-provider.ts`). The carried deployment with the owner's
// plan route set (#2091) adds the agent's turn on the plan and its adapter,
// under the plan's own provider key, so the route stays the plan's.

import {
  catalogue,
  CHATGPT_PLAN_BODY_LIMIT,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TURN,
  chatgptPlanTurnAdapter,
  readReplayLookup,
  CONVERSATION_ANSWER,
  LOCAL_GPT_COMPOSE,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_PROVIDER,
  localGptAdapter,
  localGptCostMinor,
  OLLAMA_CONVERSATION,
  OLLAMA_PROVIDER,
  ollamaAdapter,
  ollamaCostMinor,
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_CONVERSATION,
  OPENROUTER_PROVIDER,
  openrouterCostMinor,
  openrouterRequest,
  REPLAY_COMPOSE,
  REPLAY_TURN,
  replayAdapter,
  replayCostMinor,
  replayLookup,
  type ModelOperation,
} from '../../packages/core-connectors/src/index.ts';
import type { ProviderAdapter } from '../../packages/core-custody/src/index.ts';

export type AgentProvider = 'api' | 'local-gpt' | 'ollama';

/** OpenRouter's one origin: its route's destination must be exactly this. */
export const OPENROUTER_ORIGIN = 'https://openrouter.ai';

const REPLAY = {
  build: replayAdapter,
  price: replayCostMinor,
  // AW-10: the reconciliation pass asks the provider about an unknown call.
  lookup: replayLookup,
  readLookup: readReplayLookup,
};
const LOCAL_GPT = { build: localGptAdapter, price: localGptCostMinor };

const OPERATIONS = {
  // The agent's turn (#1717 R8b) is the local replay stand-in until a real provider's turn is catalogued.
  api: catalogue([REPLAY_COMPOSE, CONVERSATION_ANSWER, REPLAY_TURN]),
  'local-gpt': catalogue([REPLAY_COMPOSE, LOCAL_GPT_COMPOSE, LOCAL_GPT_CONVERSATION, REPLAY_TURN]),
  ollama: catalogue([OLLAMA_CONVERSATION]),
} as const;
const PROVIDERS = {
  api: new Map([['replay', REPLAY]]),
  'local-gpt': new Map<string, typeof REPLAY | typeof LOCAL_GPT>([
    ['replay', REPLAY],
    [LOCAL_GPT_PROVIDER, LOCAL_GPT],
  ]),
  ollama: new Map([[OLLAMA_PROVIDER, { build: ollamaAdapter, price: ollamaCostMinor }]]),
} as const;

/** OpenRouter's paid conversation operation and its adapter, the request sized before any hold. */
const OUTSIDE_OPERATIONS = catalogue([OPENROUTER_CONVERSATION]);
const OUTSIDE_ADAPTER: ProviderAdapter = {
  build: openrouterRequest,
  price: openrouterCostMinor,
  bodyLimit: OPENROUTER_BODY_LIMIT,
};

/**
 * The agent's turn on the owner's plan and its one adapter. It is the only
 * operation on the plan's provider key, since the broker finds an adapter by
 * that key: the plan's conversation operation, beside it, would need one
 * adapter for both.
 */
const PLAN_OPERATIONS = catalogue([CHATGPT_PLAN_TURN]);
const PLAN_ADAPTER: ProviderAdapter = {
  build: chatgptPlanTurnAdapter,
  price: () => 0,
  bodyLimit: CHATGPT_PLAN_BODY_LIMIT,
};

/**
 * The install's operations and adapters, with OpenRouter's where the outside
 * provider is on, and the plan's turn only where the carried deployment has
 * the plan route.
 */
export function catalogueOf(
  provider: AgentProvider,
  outside: boolean,
  plan = false,
): {
  readonly operations: ReadonlyMap<string, ModelOperation>;
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
} {
  const operations = new Map<string, ModelOperation>(OPERATIONS[provider]);
  const providers = new Map<string, ProviderAdapter>(PROVIDERS[provider]);
  if (outside) {
    for (const [key, operation] of OUTSIDE_OPERATIONS) operations.set(key, operation);
    providers.set(OPENROUTER_PROVIDER, OUTSIDE_ADAPTER);
  }
  if (plan && provider === 'ollama') {
    for (const [key, operation] of PLAN_OPERATIONS) operations.set(key, operation);
    providers.set(CHATGPT_PLAN_PROVIDER, PLAN_ADAPTER);
  }
  return { operations, providers };
}
