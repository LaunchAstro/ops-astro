// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment carries Ollama on a local route and, only where the
// outside provider is on (`OPS_OUTSIDE_PROVIDER=openrouter`), one OpenRouter
// route that is cloud and an API key. Its start refuses an OpenRouter route
// with the provider off, one of another reach or kind, a second one, any
// other cloud provider, and an outside people list wider than the people the
// model agent carries for; each refusal names a setting, never a value. Its
// broker's one priced operation is OpenRouter's paid chat: any other priced
// operation, or the paid one for a person not listed, is refused before
// custody or the database is asked anything.

import { describe, expect, it } from 'vitest';
import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { carrierSettings, type CarriedSettings } from '../../apps/api/model-carrier.ts';
import {
  OLLAMA_CONVERSATION,
  OPENROUTER_CONVERSATION,
  REPLAY_COMPOSE,
  catalogue,
} from '../../packages/core-connectors/src/index.ts';
import {
  callModelInConversation,
  type Broker,
  type ConversationCallRequest,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';

const BUSINESS = '5e0f9d2a-6b1c-4a3e-8d7f-2c4b6a8e0f13';
const AGENT = '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c';
const OWNER = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const OTHER = '1f2e3d4c-5b6a-4978-8a6b-5c4d3e2f1a0b';
const OWNER_ACTOR = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';

const ollama = {
  key: 'm5_ollama',
  reach: 'local',
  provider: 'ollama',
  credentialRef: 'carried',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 4,
};
const outside = {
  key: 'openrouter',
  reach: 'cloud',
  provider: 'openrouter',
  credentialRef: 'openrouter',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1,
};
const ON = {
  OPS_OUTSIDE_PROVIDER: 'openrouter',
  OPS_OUTSIDE_MODEL_PEOPLE: `${BUSINESS}:${OWNER}`,
};

const settings = (
  extra: Record<string, string> = {},
  routes: readonly unknown[] = [ollama, outside],
): Record<string, string> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: [OWNER] }),
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
  MODEL_BROKER_INSTALLATION: 'here',
  ...extra,
});

/** The refusal, which names a setting and holds none of the values it was given. */
function refusal(environment: Record<string, string>): string {
  const carried = carrierSettings(environment);
  if (carried.kind !== 'invalid') throw new Error(`not refused: ${carried.kind}`);
  for (const value of [AGENT, OWNER, OTHER, BUSINESS]) expect(carried.problem).not.toContain(value);
  return carried.problem;
}

function carriedOf(environment: Record<string, string>): CarriedSettings {
  const carried = carrierSettings(environment);
  if (carried.kind !== 'carried') {
    throw new Error(carried.kind === 'invalid' ? carried.problem : 'absent');
  }
  return carried;
}

describe('carried mode at start', () => {
  it('control: Ollama alone, the outside provider off, starts with no paid operation', () => {
    const carried = carriedOf(settings({}, [ollama]));
    const broker = carriedBroker(carried, {} as Custody);
    expect([...broker.operations.values()].filter((one) => one.maximumMinor > 0)).toEqual([]);
  });

  it('an OpenRouter route with the outside provider off is refused', () => {
    expect(refusal(settings())).toContain('MODEL_BROKER_ROUTES');
  });

  it('with the outside provider on, the one OpenRouter route starts, and its people are kept', () => {
    const carried = carriedOf(settings(ON));
    expect(carried.routes).toStrictEqual([ollama, outside]);
    expect(carried.outsidePeople).toStrictEqual([`${BUSINESS}:${OWNER}`]);
  });

  it.each([
    ['a local OpenRouter route', [ollama, { ...outside, reach: 'local' }]],
    ['a subscription OpenRouter route', [ollama, { ...outside, credentialKind: 'subscription' }]],
    [
      'a cloud-credential OpenRouter route',
      [ollama, { ...outside, credentialKind: 'cloud_credential' }],
    ],
    ['two OpenRouter routes', [ollama, outside, { ...outside, key: 'openrouter_2' }]],
    [
      'another cloud provider',
      [ollama, outside, { ...outside, key: 'gpt', provider: 'local_gpt' }],
    ],
    ['no Ollama local route', [outside]],
  ])('%s is refused', (_name, routes) => {
    expect(refusal(settings(ON, routes))).toContain('MODEL_BROKER_ROUTES');
  });

  it('an outside list wider than the people the agent carries for is refused', () => {
    const wider = { ...ON, OPS_OUTSIDE_MODEL_PEOPLE: `${BUSINESS}:${OWNER},${BUSINESS}:${OTHER}` };
    expect(refusal(settings(wider))).toContain('OPS_OUTSIDE_MODEL_PEOPLE');
  });

  it.each([
    ['a malformed outside list', { ...ON, OPS_OUTSIDE_MODEL_PEOPLE: OWNER }],
    ['another outside provider', { ...ON, OPS_OUTSIDE_PROVIDER: 'openai' }],
    ['a credentials file', { ...ON, MODEL_BROKER_CREDENTIALS_FILE: '/etc/credentials.json' }],
  ])('%s is refused', (_name, extra) => {
    expect(refusal(settings(extra))).toMatch(/OPS_OUTSIDE|MODEL_BROKER_CREDENTIALS_FILE/u);
  });
});

// oxlint-disable-next-line max-lines-per-function -- one broker, the operations it refuses and its control
describe('the carried broker offers one priced operation', () => {
  const asked: string[] = [];
  const custody = {
    pid: 0,
    dispatch: async () => {
      asked.push('dispatch');
      return await Promise.resolve({ kind: 'refused', started: false, code: 'X' } as const);
    },
    describe: async () => {
      asked.push('describe');
      return await Promise.resolve({
        credentialKind: 'api_key',
        account: null,
        presents: false,
      } as const);
    },
  } as unknown as Custody;
  const database = {
    withBusiness: () => {
      asked.push('database');
      throw new Error('the database was asked');
    },
  } as unknown as Database;
  const owner = { actorId: OWNER_ACTOR, delegationId: null, attendedByPersonId: OWNER };
  const request = (operation: string): ConversationCallRequest => ({
    operation,
    conversation: { id: OTHER, businessId: BUSINESS, ownerPersonId: OWNER },
    messageId: AGENT,
    fields: [{ name: 'message', source: 'outside', value: 'What is due today?' }],
    model: HAIKU,
    paid: {
      authors: [OWNER_ACTOR],
      asCaller: async () => await Promise.reject(new Error('the caller was asked')),
    },
  });
  const call = async (broker: Omit<Broker, 'audit'>, operation: string, person = OWNER) =>
    await callModelInConversation(
      database,
      BUSINESS as BusinessId,
      { ...owner, attendedByPersonId: person },
      {
        ...request(operation),
        conversation: { id: OTHER, businessId: BUSINESS, ownerPersonId: person },
      },
      { ...broker, audit: async () => {} },
    );

  it('its only priced operation is the paid chat', () => {
    const broker = carriedBroker(carriedOf(settings(ON)), custody);
    expect(
      [...broker.operations.values()].filter((one) => one.maximumMinor > 0).map((one) => one.key),
    ).toStrictEqual([OPENROUTER_CONVERSATION.key]);
  });

  it('another priced conversation operation is refused, nothing asked', async () => {
    asked.length = 0;
    const broker = carriedBroker(carriedOf(settings(ON)), custody);
    const priced = { ...OLLAMA_CONVERSATION, key: 'model.conversation_priced', maximumMinor: 25 };
    const widened = {
      ...broker,
      operations: new Map([...broker.operations, ...catalogue([priced])]),
    };
    expect(await call(widened, priced.key)).toMatchObject({ ok: false, callId: null });
    expect(await call(broker, REPLAY_COMPOSE.key)).toMatchObject({ ok: false, callId: null });
    expect(asked).toStrictEqual([]);
  });

  it('the paid chat for a person not on the outside list is refused, nothing asked', async () => {
    asked.length = 0;
    const carried = carriedOf({
      ...settings(ON),
      MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: [OWNER, OTHER] }),
    });
    const broker = carriedBroker(carried, custody);
    expect(await call(broker, OPENROUTER_CONVERSATION.key, OTHER)).toMatchObject({
      ok: false,
      code: 'LOCAL_MODEL_REQUIRED',
      callId: null,
    });
    expect(asked).toStrictEqual([]);
  });

  it('control: the paid chat for the listed owner goes on to its hold', async () => {
    asked.length = 0;
    const broker = carriedBroker(carriedOf(settings(ON)), custody);
    await expect(call(broker, OPENROUTER_CONVERSATION.key)).rejects.toThrow(
      'the database was asked',
    );
    expect(asked).toStrictEqual(['describe', 'database']);
  });
});
