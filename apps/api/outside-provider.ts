// SPDX-License-Identifier: AGPL-3.0-only
//
// The outside provider of paid chat answers (#1508), as the API's composition
// root reads it: deployment configuration, not a person's setting.
//
// - `OPS_OUTSIDE_PROVIDER`: unset is the default, and then no OpenRouter model
//   is offered anywhere; `openrouter` turns it on; anything else stops the server.
// - `OPS_OUTSIDE_MODEL_PEOPLE`: `businessId:personId` pairs, comma separated,
//   each two UUIDs; required and non-empty when the provider is on, refused when it is off.
// - The route in `MODEL_BROKER_ROUTES` whose provider is `openrouter` must be
//   `cloud` and `api_key`, and its destination exactly `https://openrouter.ai`,
//   declaring the stream format custody decodes (`openai_sse`).
//
// A refusal names the setting, never its value.

import type { BrokerRoute, Destination } from '../../packages/core-custody/src/index.ts';
import { OPENROUTER_ORIGIN } from './broker-catalogue.ts';

export const OUTSIDE_PROVIDER_SETTING = 'OPS_OUTSIDE_PROVIDER';
export const OUTSIDE_PEOPLE_SETTING = 'OPS_OUTSIDE_MODEL_PEOPLE';

export type Outside =
  | { readonly kind: 'off' }
  | { readonly kind: 'openrouter'; readonly people: readonly string[] }
  | { readonly kind: 'invalid'; readonly problem: string };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** One `businessId:personId` pair, as a people setting lists them. */
export const PAIR: RegExp = new RegExp(`^${UUID}:${UUID}$`, 'u');

/** The outside provider's two settings, or why they are refused. */
export function outsideOf(environment: Readonly<Record<string, string | undefined>>): Outside {
  const named = environment[OUTSIDE_PROVIDER_SETTING] ?? '';
  const listed = environment[OUTSIDE_PEOPLE_SETTING] ?? '';
  if (named === '') {
    return listed === ''
      ? { kind: 'off' }
      : {
          kind: 'invalid',
          problem: `${OUTSIDE_PEOPLE_SETTING} is set but ${OUTSIDE_PROVIDER_SETTING} is not`,
        };
  }
  if (named !== 'openrouter') {
    return { kind: 'invalid', problem: `${OUTSIDE_PROVIDER_SETTING} is not openrouter` };
  }
  const people = listed.split(',').map((pair) => pair.trim().toLowerCase());
  if (listed.trim() === '' || !people.every((pair) => PAIR.test(pair))) {
    return {
      kind: 'invalid',
      problem: `${OUTSIDE_PEOPLE_SETTING} is not a list of businessId:personId pairs`,
    };
  }
  return { kind: 'openrouter', people };
}

/** Why the configured OpenRouter route or its destination is refused, if it is. */
export function outsideRouteProblem(
  destinations: ReadonlyMap<string, Destination>,
  routes: readonly BrokerRoute[],
): string | undefined {
  const outside = routes.filter((route) => route.provider === 'openrouter');
  if (outside.length === 0) {
    return `${OUTSIDE_PROVIDER_SETTING} is openrouter but MODEL_BROKER_ROUTES has no openrouter route`;
  }
  if (outside.some((route) => route.reach !== 'cloud' || route.credentialKind !== 'api_key')) {
    return 'MODEL_BROKER_ROUTES has an openrouter route that is not a cloud api_key route';
  }
  const destination = destinations.get('openrouter');
  if (destination?.origin !== OPENROUTER_ORIGIN || destination.stream !== 'openai_sse') {
    return `MODEL_BROKER_DESTINATIONS' openrouter destination is not exactly ${OPENROUTER_ORIGIN} with stream openai_sse`;
  }
  return undefined;
}
