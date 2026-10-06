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
// model, and the laptop runner's default. A model the owner approves on the
// laptop is the runner's own business (`apps/local-agent/gate.ts`), so it is
// never offered here.

import {
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_DEFAULT_MODEL,
  LOCAL_GPT_PROVIDER,
} from './local-gpt.ts';
import { CONVERSATION_ANSWER, REPLAY_MODEL_WINDOW } from './replay.ts';

export interface ConversationModel {
  readonly id: string;
  readonly provider: string;
  readonly reach: 'local' | 'cloud';
  /** The provider's name in a client's privacy settings. */
  readonly egressName: 'replay' | 'chatgpt';
  /** The price-book entry: the most one call may cost, in AUD minor units. */
  readonly ceilingMinor: number;
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
];

/** The models one provider's conversation operation runs, its default first. */
export const conversationModelsOf = (provider: string): readonly ConversationModel[] =>
  CONVERSATION_MODELS.filter((model) => model.provider === provider);

/**
 * The provider this install's conversation operation is on, by the rule the
 * API's composition root applies (`apps/api/model-broker.ts`): `local-gpt`
 * only where `OPS_ENVIRONMENT` is `local`, the replay provider otherwise. A
 * setting the root refuses never serves a request, so this never has to.
 */
export function conversationProviderOf(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  return environment['OPS_AGENT_PROVIDER'] === 'local-gpt' &&
    environment['OPS_ENVIRONMENT'] === 'local'
    ? LOCAL_GPT_PROVIDER
    : CONVERSATION_ANSWER.provider;
}
