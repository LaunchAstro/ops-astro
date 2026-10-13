// SPDX-License-Identifier: AGPL-3.0-only
//
// The operations and their adapters, per provider, as the API's composition
// root registers them (AW-01): in code and reviewed, never configured. The
// outside provider (#1508) adds OpenRouter's paid conversation operation and
// its adapter beside any of them, only where `OPS_OUTSIDE_PROVIDER` is
// `openrouter` (`outside-provider.ts`).

import {
  catalogue,
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
  api: catalogue([REPLAY_COMPOSE, CONVERSATION_ANSWER]),
  'local-gpt': catalogue([REPLAY_COMPOSE, LOCAL_GPT_COMPOSE, LOCAL_GPT_CONVERSATION]),
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

/** The install's operations and adapters, with OpenRouter's where the outside provider is on. */
export function catalogueOf(
  provider: AgentProvider,
  outside: boolean,
): {
  readonly operations: ReadonlyMap<string, ModelOperation>;
  readonly providers: ReadonlyMap<string, ProviderAdapter>;
} {
  const operations: ReadonlyMap<string, ModelOperation> = OPERATIONS[provider];
  const providers: ReadonlyMap<string, ProviderAdapter> = PROVIDERS[provider];
  if (!outside) return { operations, providers };
  return {
    operations: new Map([...operations, ...OUTSIDE_OPERATIONS]),
    providers: new Map([...providers, [OPENROUTER_PROVIDER, OUTSIDE_ADAPTER]]),
  };
}
