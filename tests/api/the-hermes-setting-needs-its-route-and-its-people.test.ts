// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: Hermes Agent as a production setting. Only the carried deployment,
// whose custody is the model agent on the M5, takes it: `OPS_HERMES_PEOPLE`
// names who is offered it, as `businessId:personId` pairs, each a person the
// agent carries for, and `MODEL_BROKER_ROUTES` then holds exactly one Hermes
// route, local and an API key, since custody calls it on the M5's loopback.
// With both, the carried broker serves Hermes Agent's conversation operation
// on its own adapter. A route without the setting, the setting without its
// route, a loose route, a malformed list, a person the agent does not carry
// for, or the setting on an uncarried install each stops the server, naming
// the setting and never its value.

import { describe, expect, it } from 'vitest';
import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { carrierSettings, type CarriedSettings } from '../../apps/api/model-carrier.ts';
import {
  HERMES_BODY_LIMIT,
  HERMES_CONVERSATION_KEY,
  HERMES_PROVIDER,
  hermesRequest,
} from '../../packages/core-connectors/src/index.ts';
import type { Custody } from '../../packages/core-custody/src/index.ts';

const BUSINESS = '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10';
const AGENT = '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c';
const OWNER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const COLLEAGUE = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b';
const PEOPLE = `${BUSINESS}:${OWNER}`;

const ollama = {
  key: 'm5_ollama',
  reach: 'local',
  provider: 'ollama',
  credentialRef: 'carried',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 4,
};
const hermes = {
  key: 'm5_hermes',
  reach: 'local',
  provider: HERMES_PROVIDER,
  credentialRef: 'carried',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1,
};

const settings = (
  routes: readonly unknown[],
  people: string | null = PEOPLE,
  carried: readonly string[] = [OWNER],
): Record<string, string> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: carried }),
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
  MODEL_BROKER_INSTALLATION: 'here',
  ...(people === null ? {} : { OPS_HERMES_PEOPLE: people }),
});

function carriedOf(environment: Record<string, string>): CarriedSettings {
  const carried = carrierSettings(environment);
  if (carried.kind !== 'carried') {
    throw new Error(carried.kind === 'invalid' ? carried.problem : 'absent');
  }
  return carried;
}

function refused(environment: Record<string, string>): string {
  const carried = carrierSettings(environment);
  if (carried.kind !== 'invalid') throw new Error(`not refused: ${carried.kind}`);
  for (const value of [AGENT, OWNER, BUSINESS]) expect(carried.problem).not.toContain(value);
  return carried.problem;
}

describe('Hermes Agent on the carried deployment', () => {
  it('takes one local api_key route with its people, and serves its operation on its own adapter', () => {
    const carried = carriedOf(settings([ollama, hermes]));
    expect(carried.routes).toStrictEqual([ollama, hermes]);
    expect(carried.hermesPeople).toStrictEqual([PEOPLE]);
    const broker = carriedBroker(carried, {} as Custody);
    expect(broker.operations.get(HERMES_CONVERSATION_KEY)?.provider).toBe(HERMES_PROVIDER);
    const adapter = broker.providers.get(HERMES_PROVIDER);
    expect(adapter?.bodyLimit).toBe(HERMES_BODY_LIMIT);
    expect(adapter?.build({ message: 'Hello' })).toStrictEqual(hermesRequest({ message: 'Hello' }));
  });

  it('without the setting, no Hermes operation is catalogued', () => {
    const broker = carriedBroker(carriedOf(settings([ollama], null)), {} as Custody);
    expect(broker.operations.has(HERMES_CONVERSATION_KEY)).toBe(false);
    expect(broker.providers.has(HERMES_PROVIDER)).toBe(false);
  });

  it.each([
    ['a Hermes route without the setting', settings([ollama, hermes], null)],
    ['the setting without a Hermes route', settings([ollama])],
    ['a cloud Hermes route', settings([ollama, { ...hermes, reach: 'cloud' }])],
    [
      'a Hermes route on a subscription',
      settings([ollama, { ...hermes, credentialKind: 'subscription' }]),
    ],
    ['two Hermes routes', settings([ollama, hermes, { ...hermes, key: 'm5_hermes_2' }])],
    [
      'a person the agent does not carry for',
      settings([ollama, hermes], `${BUSINESS}:${COLLEAGUE}`),
    ],
    ['a pair that is not two ids', settings([ollama, hermes], OWNER)],
    ['an empty entry', settings([ollama, hermes], `${PEOPLE},,`)],
  ])('%s is refused', (_name, environment) => {
    expect(refused(environment)).toContain('MODEL_BROKER_CARRIER');
  });

  it('an install with no carrier refuses the setting', () => {
    const uncarried = carrierSettings({ OPS_AGENT_PROVIDER: 'api', OPS_HERMES_PEOPLE: PEOPLE });
    expect(uncarried).toMatchObject({ kind: 'invalid' });
    expect(JSON.stringify(uncarried)).toContain('OPS_HERMES_PEOPLE');
    expect(JSON.stringify(uncarried)).not.toContain(OWNER);
  });
});
