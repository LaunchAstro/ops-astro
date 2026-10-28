// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's answers (live chat route B): its conversation calls,
// and its tasks' model calls (#1703), go to the model agent on the owner's
// machine over Supabase Realtime, through the carried custody, and the
// function holds no provider credential. It
// needs the carry key (and, during a rotation, the next one), the project's
// secure Realtime address, and its publishable key; missing or malformed, the
// deployment does not start, naming the setting and never its value.

import {
  conversationExchange,
  modelCallExecutor,
  type ConversationExchange,
  type ModelBroker,
  type ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';
import {
  carriedCustody,
  carriesOnPlan,
  parseCarryKeys,
  realtimeCarriage,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import type { Carrier } from '../../packages/core-custody/src/index.ts';
import { catalogueOf } from './broker-catalogue.ts';
import { carrierSettings, type CarriedSettings } from './model-carrier.ts';

type Settings = Readonly<Record<string, string | undefined>>;

export const CARRY_KEY_SETTING = 'MODEL_BROKER_CARRY_KEY';
export const CARRY_KEY_NEXT_SETTING = 'MODEL_BROKER_CARRY_KEY_NEXT';
export const REALTIME_URL_SETTING = 'SUPABASE_REALTIME_URL';

/**
 * The carried broker over `custody`, holding no credential: Ollama's
 * conversation, OpenRouter's paid one where the outside provider is on, and
 * the agent's turn on the owner's plan where its route is set (#2091), and
 * Hermes Agent's conversation where its people are set (#2270).
 */
export const carriedBroker = (carried: CarriedSettings, custody: Custody): ModelBroker => ({
  custody,
  ...catalogueOf(
    'ollama',
    carried.outsidePeople.length > 0,
    carried.routes.some((route) => carriesOnPlan(route)),
    carried.hermesPeople.length > 0,
  ),
  routes: carried.routes,
  installation: carried.installation,
  carrier: carried.carrier,
  outsidePeople: carried.outsidePeople,
  hermesPeople: carried.hermesPeople,
});

/** The carried exchange and executor, or a throw naming the setting that is missing or malformed. */
export function carriedAnswers(
  environment: Settings,
  carried: CarriedSettings,
): {
  readonly answerConversation: ConversationExchange;
  readonly executeModelCall: ModelCallExecutor;
} {
  const keys = parseCarryKeys(environment[CARRY_KEY_SETTING], environment[CARRY_KEY_NEXT_SETTING]);
  if (!keys.ok) {
    throw new Error(
      `${CARRY_KEY_SETTING} and ${CARRY_KEY_NEXT_SETTING} must be distinct base64url keys of 32 bytes or more`,
    );
  }
  const url = environment[REALTIME_URL_SETTING] ?? '';
  if (!/^wss:\/\/[^/\s]+\/realtime\/v1$/u.test(url)) {
    throw new Error(`${REALTIME_URL_SETTING} must be the project's wss://…/realtime/v1 address`);
  }
  const apiKey = environment['SUPABASE_PUBLISHABLE_KEY'] ?? '';
  if (apiKey === '') throw new Error('SUPABASE_PUBLISHABLE_KEY is needed to join Realtime');
  const key = environment[CARRY_KEY_SETTING] ?? '';
  const custody = carriedCustody({
    carriage: realtimeCarriage({ url, apiKey }),
    keys: keys.keys,
    key,
  });
  const broker = carriedBroker(carried, custody);
  return {
    answerConversation: conversationExchange(broker),
    executeModelCall: modelCallExecutor(broker),
  };
}

/**
 * The composition roots' option: a carried deployment's carrier and its
 * carried answers, or nothing; a refused setting throws, naming it.
 */
export function carriedOption(environment: Settings): {
  readonly carrier?: Carrier;
  readonly answerConversation?: ConversationExchange;
  readonly executeModelCall?: ModelCallExecutor;
} {
  const carried = carrierSettings(environment);
  if (carried.kind === 'invalid') throw new Error(carried.problem);
  if (carried.kind !== 'carried') return {};
  return { carrier: carried.carrier, ...carriedAnswers(environment, carried) };
}
