// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's setting (#1531). `MODEL_BROKER_CARRIER` names the model
// agent on the owner's machine and the people it carries calls for, Ollama only
// and with no provider credential. Refused, the server stops, naming the
// setting and never its value; unset, its broker is custody's own.

import { OLLAMA_PROVIDER } from '../../packages/core-connectors/src/index.ts';
import type { BrokerRoute, Carrier } from '../../packages/core-custody/src/index.ts';
import { agentProvider, AGENT_PROVIDER_SETTING, routesOf } from './model-broker.ts';

type Settings = Readonly<Record<string, string | undefined>>;

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

/** Why the carried deployment is refused, naming settings and never a value; undefined when it will do. */
function problemOf(
  environment: Settings,
  carrier: Carrier | undefined,
  routes: readonly (BrokerRoute | undefined)[] | undefined,
): string | undefined {
  const set = (name: string): boolean => (environment[name] ?? '') !== '';
  if (agentProvider(environment) !== 'ollama') {
    return `carries Ollama only: ${AGENT_PROVIDER_SETTING} must be ollama`;
  }
  if (set('MODEL_BROKER_CREDENTIALS_FILE') || set('MODEL_BROKER_DESTINATIONS')) {
    return 'holds no provider credential: unset MODEL_BROKER_CREDENTIALS_FILE and MODEL_BROKER_DESTINATIONS';
  }
  if (carrier === undefined)
    return 'is not exactly {"agent":<id>,"people":[<id>, ...]} in lower case';
  const local = routes?.some(
    (route) => route?.provider === OLLAMA_PROVIDER && route.reach === 'local',
  );
  return local === true && !routes?.includes(undefined) && set('MODEL_BROKER_INSTALLATION')
    ? undefined
    : 'needs MODEL_BROKER_ROUTES with an Ollama local route, and MODEL_BROKER_INSTALLATION';
}

/** The carried deployment, or why it is refused; absent where `MODEL_BROKER_CARRIER` is unset. */
export function carrierSettings(
  environment: Settings,
):
  | { readonly kind: 'absent' }
  | CarriedSettings
  | { readonly kind: 'invalid'; readonly problem: string } {
  const text = environment[CARRIER_SETTING] ?? '';
  if (text === '') return { kind: 'absent' };
  const carrier = carrierOf(text);
  const routes = routesOf(environment['MODEL_BROKER_ROUTES'] ?? '', 'ollama');
  const problem = problemOf(environment, carrier, routes);
  if (problem !== undefined || carrier === undefined) {
    return { kind: 'invalid', problem: `${CARRIER_SETTING} ${problem ?? ''}` };
  }
  const installation = environment['MODEL_BROKER_INSTALLATION'] ?? '';
  return { kind: 'carried', carrier, routes: routes as readonly BrokerRoute[], installation };
}

/** The composition roots' option: the carrier, or none; a refused setting throws, naming it. */
export function carrierOption(environment: Settings): { readonly carrier?: Carrier } {
  const carried = carrierSettings(environment);
  if (carried.kind === 'invalid') throw new Error(carried.problem);
  return carried.kind === 'carried' ? { carrier: carried.carrier } : {};
}
