// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's setting (#1531, live chat route B), as the API's
// composition roots read it. `MODEL_BROKER_CARRIER` is
// `{"agent":<agent actor id>,"people":[<person id>, ...]}`: the model agent on
// the owner's machine and the people it carries conversation calls for. It
// runs Ollama only, on a local route, and holds no provider credential: a
// credentials file or a destination beside it, or a malformed setting, stops
// the server with a problem naming the setting and never its value. Unset,
// the deployment carries nothing and its broker is custody's own.

import { OLLAMA_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import type { BrokerRoute, Carrier } from '../../packages/core-custody/src/index.ts';
import { agentProvider, AGENT_PROVIDER_SETTING, routesOf } from './model-broker.ts';

type Refused = { readonly kind: 'invalid'; readonly problem: string };
const invalid = (problem: string): Refused => ({ kind: 'invalid', problem });

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export const CARRIER_SETTING = 'MODEL_BROKER_CARRIER';

export interface CarriedSettings {
  readonly kind: 'carried';
  readonly carrier: Carrier;
  readonly routes: readonly BrokerRoute[];
  readonly installation: string;
}

/** A lower-case uuid, as every id is written and every topic names it. */
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);

/** The carrier, exactly `{agent, people}`, or undefined. */
function carrierOf(text: string): Carrier | undefined {
  const shape = parsed(text);
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) return undefined;
  const { agent, people, ...rest } = shape as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || !isId(agent) || !Array.isArray(people)) return undefined;
  const listed: unknown[] = people;
  if (
    listed.length === 0 ||
    !listed.every((one) => isId(one)) ||
    new Set(listed).size !== listed.length
  ) {
    return undefined;
  }
  return { agent, people: listed };
}

/**
 * The carried deployment, from its settings, or why it is refused (never echoing
 * a value); absent where `MODEL_BROKER_CARRIER` is unset.
 */
export function carrierSettings(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly kind: 'absent' } | CarriedSettings | Refused {
  const text = environment[CARRIER_SETTING] ?? '';
  if (text === '') return { kind: 'absent' };
  if (agentProvider(environment) !== 'ollama') {
    return invalid(
      `${CARRIER_SETTING} carries Ollama only: ${AGENT_PROVIDER_SETTING} must be ollama`,
    );
  }
  if (
    (environment['MODEL_BROKER_CREDENTIALS_FILE'] ?? '') !== '' ||
    (environment['MODEL_BROKER_DESTINATIONS'] ?? '') !== ''
  ) {
    return invalid(
      `${CARRIER_SETTING} holds no provider credential: unset MODEL_BROKER_CREDENTIALS_FILE ` +
        'and MODEL_BROKER_DESTINATIONS',
    );
  }
  const carrier = carrierOf(text);
  if (carrier === undefined) {
    return invalid(
      `${CARRIER_SETTING} is not exactly {"agent":<id>,"people":[<id>, ...]}, ` +
        'lower-case ids, at least one person, none twice',
    );
  }
  const routes = routesOf(environment['MODEL_BROKER_ROUTES'] ?? '', 'ollama');
  const installation = environment['MODEL_BROKER_INSTALLATION'] ?? '';
  if (
    routes === undefined ||
    routes.includes(undefined) ||
    !routes.some((route) => route?.provider === OLLAMA_PROVIDER && route.reach === 'local') ||
    installation === ''
  ) {
    return invalid(
      `${CARRIER_SETTING} needs MODEL_BROKER_ROUTES with an Ollama local route, ` +
        'and MODEL_BROKER_INSTALLATION',
    );
  }
  return { kind: 'carried', carrier, routes: routes as readonly BrokerRoute[], installation };
}

/** The composition roots' option: the carrier, or none; a refused setting throws, naming it. */
export function carrierOption(environment: Readonly<Record<string, string | undefined>>): {
  readonly carrier?: Carrier;
} {
  const carried = carrierSettings(environment);
  if (carried.kind === 'invalid') throw new Error(carried.problem);
  return carried.kind === 'carried' ? { carrier: carried.carrier } : {};
}
