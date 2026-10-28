// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's setting (#1531). `MODEL_BROKER_CARRIER` names the model
// agent on the owner's machine and the people it carries calls for, Ollama only
// and with no provider credential. Refused, the server stops, naming the
// setting and never its value; unset, its broker is custody's own.
//
// With the outside provider on (`OPS_OUTSIDE_PROVIDER=openrouter`, #1508) it
// carries one priced operation more, OpenRouter's paid chat, on one route that
// is cloud and an API key, whose key only the agent's custody holds; its
// outside people must all be people the agent carries for.
//
// With one route on the owner's ChatGPT plan, cloud and his subscription
// (#2091), the agent's turn is carried there too; at most one, and no other
// install takes such a route.
//
// With Hermes Agent's people set (`OPS_HERMES_PEOPLE`, #2270), it carries
// Hermes Agent's conversation on exactly one route, local and an API key,
// since custody calls it on the M5's loopback under a key only the agent's
// custody holds; its people must all be people the agent carries for. The
// setting on an install with no carrier stops the server.

import {
  CHATGPT_PLAN_PROVIDER,
  HERMES_PROVIDER,
  OLLAMA_PROVIDER,
  OPENROUTER_PROVIDER,
} from '../../packages/core-connectors/src/index.ts';
import type { BrokerRoute, Carrier } from '../../packages/core-custody/src/index.ts';
import { HERMES_PEOPLE_SETTING, hermesPeopleSetting, type HermesPeople } from './hermes-people.ts';
import { agentProvider, AGENT_PROVIDER_SETTING, routesOf } from './model-broker.ts';
import { outsideOf, OUTSIDE_PEOPLE_SETTING, type Outside } from './outside-provider.ts';

type Settings = Readonly<Record<string, string | undefined>>;

export const CARRIER_SETTING = 'MODEL_BROKER_CARRIER';

export interface CarriedSettings {
  readonly kind: 'carried';
  readonly carrier: Carrier;
  readonly routes: readonly BrokerRoute[];
  readonly installation: string;
  /** `businessId:personId` pairs the paid chat is for; none with the outside provider off. */
  readonly outsidePeople: readonly string[];
  /** `businessId:personId` pairs Hermes Agent is offered to; none with its setting unset. */
  readonly hermesPeople: readonly string[];
}

/** A lower-case uuid, as every id is written and every topic names it. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** The carrier, exactly `{agent, people}` with at least one person and none twice, or undefined. */
function carrierOf(text: string): Carrier | undefined {
  let shape: unknown;
  try {
    shape = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return undefined;
  const { agent, people, ...rest } = shape as Record<string, unknown>;
  const listed: unknown[] = Array.isArray(people) ? people : [];
  const ok =
    Object.keys(rest).length === 0 && listed.length > 0 && new Set(listed).size === listed.length;
  return ok && isId(agent) && listed.every((one) => isId(one))
    ? { agent, people: listed as string[] }
    : undefined;
}

/** One OpenRouter route with the outside provider on, none with it off, and only a cloud API key one. */
const oneOutsideRoute = (routes: readonly BrokerRoute[], on: boolean): boolean => {
  const outside = routes.filter((route) => route.provider === OPENROUTER_PROVIDER);
  return (
    outside.length === (on ? 1 : 0) &&
    outside.every((route) => route.reach === 'cloud' && route.credentialKind === 'api_key')
  );
};

/** One Hermes route with its people set, none without, and only a local API key one. */
const oneHermesRoute = (routes: readonly BrokerRoute[], on: boolean): boolean => {
  const hermes = routes.filter((route) => route.provider === HERMES_PROVIDER);
  return (
    hermes.length === (on ? 1 : 0) &&
    hermes.every((route) => route.reach === 'local' && route.credentialKind === 'api_key')
  );
};

/** Each pair's person, of `people`, one the agent carries for. */
const carriesAll = (people: readonly string[], carrier: Carrier): boolean =>
  people.every((pair) => carrier.people.includes(pair.split(':')[1] ?? ''));

/** Each outside pair's person one the agent carries for. */
const within = (outside: Outside, carrier: Carrier): boolean =>
  outside.kind !== 'openrouter' || carriesAll(outside.people, carrier);

/** Why the carried deployment is refused, naming settings and never a value; undefined when it will do. */
// oxlint-disable-next-line max-statements -- one check per setting, in the order a refusal names them
function problemOf(
  environment: Settings,
  carrier: Carrier | undefined,
  routes: readonly (BrokerRoute | undefined)[] | undefined,
  outside: Outside,
  hermes: HermesPeople,
): string | undefined {
  const set = (name: string): boolean => (environment[name] ?? '') !== '';
  if (agentProvider(environment) !== 'ollama') {
    return `carries Ollama only: ${AGENT_PROVIDER_SETTING} must be ollama`;
  }
  if (set('MODEL_BROKER_CREDENTIALS_FILE') || set('MODEL_BROKER_DESTINATIONS')) {
    return 'holds no provider credential: unset MODEL_BROKER_CREDENTIALS_FILE and MODEL_BROKER_DESTINATIONS';
  }
  if (outside.kind === 'invalid') return `cannot start: ${outside.problem}`;
  if (hermes.kind === 'invalid') return `cannot start: ${hermes.problem}`;
  if (carrier === undefined)
    return 'is not exactly {"agent":<id>,"people":[<id>, ...]} in lower case';
  if (!within(outside, carrier)) return `carries for fewer people than ${OUTSIDE_PEOPLE_SETTING}`;
  if (hermes.kind === 'on' && !carriesAll(hermes.people, carrier)) {
    return `carries for fewer people than ${HERMES_PEOPLE_SETTING}`;
  }
  const listed = routes?.includes(undefined) === false ? (routes as readonly BrokerRoute[]) : [];
  const local = listed.some(
    (route) => route.provider === OLLAMA_PROVIDER && route.reach === 'local',
  );
  const on = outside.kind === 'openrouter';
  const plans = listed.filter((route) => route.provider === CHATGPT_PLAN_PROVIDER).length;
  return local &&
    oneOutsideRoute(listed, on) &&
    plans <= 1 &&
    oneHermesRoute(listed, hermes.kind === 'on') &&
    set('MODEL_BROKER_INSTALLATION')
    ? undefined
    : 'needs MODEL_BROKER_ROUTES with an Ollama local route, exactly one cloud api_key ' +
        'OpenRouter route with OPS_OUTSIDE_PROVIDER (none without), at most one cloud ' +
        'subscription ChatGPT plan route, exactly one local api_key Hermes route with ' +
        `${HERMES_PEOPLE_SETTING} (none without), no two sharing a key, and MODEL_BROKER_INSTALLATION`;
}

/**
 * The carried deployment, or why it is refused; absent where `MODEL_BROKER_CARRIER`
 * is unset, unless Hermes Agent's people are set, which only it takes.
 */
export function carrierSettings(
  environment: Settings,
):
  | { readonly kind: 'absent' }
  | CarriedSettings
  | { readonly kind: 'invalid'; readonly problem: string } {
  const text = environment[CARRIER_SETTING] ?? '';
  if (text === '' && (environment[HERMES_PEOPLE_SETTING] ?? '') !== '') {
    return { kind: 'invalid', problem: `${HERMES_PEOPLE_SETTING} needs ${CARRIER_SETTING}` };
  }
  if (text === '') return { kind: 'absent' };
  const carrier = carrierOf(text);
  const outside = outsideOf(environment);
  const on = outside.kind === 'openrouter';
  const hermes = hermesPeopleSetting(environment);
  const routes = routesOf(
    environment['MODEL_BROKER_ROUTES'] ?? '',
    'ollama',
    on,
    true,
    hermes.kind === 'on',
  );
  const problem = problemOf(environment, carrier, routes, outside, hermes);
  if (problem !== undefined || carrier === undefined) {
    return { kind: 'invalid', problem: `${CARRIER_SETTING} ${problem ?? ''}` };
  }
  const installation = environment['MODEL_BROKER_INSTALLATION'] ?? '';
  return {
    kind: 'carried',
    carrier,
    routes: routes as readonly BrokerRoute[],
    installation,
    outsidePeople: on ? outside.people : [],
    hermesPeople: hermes.kind === 'on' ? hermes.people : [],
  };
}

/** The composition roots' option: the carrier, or none; a refused setting throws, naming it. */
export function carrierOption(environment: Settings): { readonly carrier?: Carrier } {
  const carried = carrierSettings(environment);
  if (carried.kind === 'invalid') throw new Error(carried.problem);
  return carried.kind === 'carried' ? { carrier: carried.carrier } : {};
}
