// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried paid call's standing names one person in one business, whatever
// the letters its ids are written in:
//
//   - an outside people list written in capitals is the same list: a carried
//     deployment starts with it, keeps it in lower case, and the listed owner's
//     paid chat goes on to its hold;
//   - a carrier whose people are written in capitals is refused at start,
//     naming the setting and never a value;
//   - at a judgement's locked instant (`standsOutside`) the person stands
//     only for the business the list pairs them with, only on the route the
//     call was held on, and only while the conversation is on the model it
//     was asked on; a pair in other letters is the same pair, never a second
//     identity, and another person in other letters is never this one.

import { describe, expect, it } from 'vitest';
import { carriedBroker } from '../../apps/api/model-carriage.ts';
import { carrierSettings } from '../../apps/api/model-carrier.ts';
import { OPENROUTER_CONVERSATION } from '../../packages/core-connectors/src/index.ts';
import {
  callModelInConversation,
  standsOutside,
  type Custody,
} from '../../packages/core-custody/src/index.ts';
import type { BusinessId, Database } from '../../packages/core-records/src/index.ts';
import { HAIKU } from './openrouter-stand-in-fixture.ts';

const BUSINESS = '5e0f9d2a-6b1c-4a3e-8d7f-2c4b6a8e0f13';
const BRAVO = '8b7a6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d';
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
} as const;
const outside = {
  key: 'openrouter',
  reach: 'cloud',
  provider: 'openrouter',
  credentialRef: 'openrouter',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 1,
} as const;

const settings = (people: string, carried: readonly string[] = [OWNER]) => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: AGENT, people: carried }),
  MODEL_BROKER_ROUTES: JSON.stringify([ollama, outside]),
  MODEL_BROKER_INSTALLATION: 'here',
  OPS_OUTSIDE_PROVIDER: 'openrouter',
  OPS_OUTSIDE_MODEL_PEOPLE: people,
});

// oxlint-disable-next-line max-lines-per-function -- the two settings and the call that follows
describe('the settings lists in other letters', () => {
  it('an outside list in capitals starts, kept in lower case, and the owner’s paid chat goes to its hold', async () => {
    const carried = carrierSettings(settings(`${BUSINESS}:${OWNER}`.toUpperCase()));
    if (carried.kind !== 'carried') throw new Error(`not carried: ${carried.kind}`);
    expect(carried.outsidePeople).toStrictEqual([`${BUSINESS}:${OWNER}`]);
    const asked: string[] = [];
    const custody = {
      pid: 0,
      dispatch: async () => await Promise.reject(new Error('custody was asked to send')),
      describe: async () => {
        asked.push('describe');
        return await Promise.resolve({ credentialKind: 'api_key', account: null, presents: false });
      },
    } as unknown as Custody;
    const database = {
      withBusiness: () => {
        asked.push('database');
        throw new Error('the database was asked');
      },
    } as unknown as Database;
    const broker = { ...carriedBroker(carried, custody), audit: async () => {} };
    await expect(
      callModelInConversation(
        database,
        BUSINESS as BusinessId,
        { actorId: OWNER_ACTOR, delegationId: null, attendedByPersonId: OWNER },
        {
          operation: OPENROUTER_CONVERSATION.key,
          conversation: { id: OTHER, businessId: BUSINESS, ownerPersonId: OWNER },
          messageId: AGENT,
          fields: [{ name: 'message', source: 'outside', value: 'What is due today?' }],
          model: HAIKU,
          paid: {
            authors: [OWNER_ACTOR],
            asCaller: async () => await Promise.reject(new Error('the caller was asked')),
          },
        },
        broker,
      ),
    ).rejects.toThrow('the database was asked');
    expect(asked).toStrictEqual(['describe', 'database']);
  });

  it('a carrier whose people are in capitals is refused, naming the setting and no value', () => {
    const carried = carrierSettings(settings(`${BUSINESS}:${OWNER}`, [OWNER.toUpperCase()]));
    expect(carried.kind).toBe('invalid');
    const problem = carried.kind === 'invalid' ? carried.problem : '';
    expect(problem).toContain('MODEL_BROKER_CARRIER');
    for (const value of [OWNER, OWNER.toUpperCase(), BUSINESS])
      expect(problem).not.toContain(value);
  });
});

// oxlint-disable-next-line max-lines-per-function -- the standing and each way it is lost
describe('the standing judged at the locked instant', () => {
  const held = {
    operation: OPENROUTER_CONVERSATION.key,
    provider: 'openrouter',
    route: 'openrouter',
    model: HAIKU,
  };
  const asked = { businessId: BUSINESS, actorId: OWNER_ACTOR, personId: OWNER, model: HAIKU };
  const broker = (people: readonly string[]) => ({
    installation: 'here',
    outsidePeople: people,
    routes: [ollama, outside],
  });

  it('control: the listed owner on the held route and model stands', () => {
    expect(standsOutside(broker([`${BUSINESS}:${OWNER}`]), held, asked)).toBe(true);
  });

  it('a pair in other letters is the same pair', () => {
    const mixed = `${BUSINESS.toUpperCase()}:${OWNER.slice(0, 8).toUpperCase()}${OWNER.slice(8)}`;
    expect(standsOutside(broker([mixed]), held, asked)).toBe(true);
    expect(
      standsOutside(broker([`${BUSINESS}:${OWNER}`]), held, {
        ...asked,
        businessId: BUSINESS.toUpperCase(),
        personId: OWNER.toUpperCase(),
      }),
    ).toBe(true);
  });

  it.each([
    ['the person listed for another business only', [`${BRAVO}:${OWNER}`], held, asked],
    ['another person listed, in capitals', [`${BUSINESS}:${OTHER}`.toUpperCase()], held, asked],
    ['nobody listed', [], held, asked],
    [
      'a route the broker no longer has',
      [`${BUSINESS}:${OWNER}`],
      { ...held, route: 'gone' },
      asked,
    ],
    [
      'the call held on the Ollama route',
      [`${BUSINESS}:${OWNER}`],
      { ...held, route: 'm5_ollama' },
      asked,
    ],
    [
      'the conversation moved off the model',
      [`${BUSINESS}:${OWNER}`],
      { ...held, model: null },
      asked,
    ],
    [
      'the conversation on the model in other letters',
      [`${BUSINESS}:${OWNER}`],
      { ...held, model: HAIKU.toUpperCase() },
      asked,
    ],
    ['the call asked on no model', [`${BUSINESS}:${OWNER}`], held, { ...asked, model: undefined }],
  ] as const)('%s: does not stand', (_name, people, call, party) => {
    expect(standsOutside(broker(people), call, party)).toBe(false);
  });
});
