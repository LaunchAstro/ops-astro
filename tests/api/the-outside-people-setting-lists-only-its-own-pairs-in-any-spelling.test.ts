// SPDX-License-Identifier: AGPL-3.0-only
//
// `OPS_OUTSIDE_MODEL_PEOPLE` in the spellings an operator might type: ids in
// upper case, spaces or tabs around a pair, a pair listed twice. Each is read
// as the same lower-case pairs by the API's composition root and by the
// commands that offer the paid model, and the carve-out admits exactly those
// pairs: the same person in another business, or a pair written backwards, is
// never admitted. A space inside a pair, an empty entry, a newline between
// pairs or a provider in another case stops the server, and the commands then
// list nobody.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import { outsidePeopleOf } from '../../packages/core-connectors/src/index.ts';
import { carriesOutside } from '../../packages/core-custody/src/outside-carriage.ts';

const business = randomUUID();
const otherBusiness = randomUUID();
const person = randomUUID();
const actor = randomUUID();
const PAIR = `${business}:${person}`;

const ROUTES = [
  {
    key: 'm5_ollama',
    reach: 'local',
    provider: 'ollama',
    credentialRef: 'ollama_key',
    credentialKind: 'api_key',
    installation: 'here',
    ceiling: 4,
  },
  {
    key: 'openrouter',
    reach: 'cloud',
    provider: 'openrouter',
    credentialRef: 'openrouter',
    credentialKind: 'api_key',
    installation: 'here',
    ceiling: 1,
  },
] as const;

const environment = (people: string, provider = 'openrouter') => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CREDENTIALS_FILE: '/nowhere/credentials.json',
  MODEL_BROKER_DESTINATIONS: JSON.stringify([
    { key: 'ollama', origin: 'http://127.0.0.1:11434' },
    { key: 'openrouter', origin: 'https://openrouter.ai', stream: 'openai_sse' },
  ]),
  MODEL_BROKER_ROUTES: JSON.stringify(ROUTES),
  MODEL_BROKER_INSTALLATION: 'here',
  OPS_OUTSIDE_PROVIDER: provider,
  OPS_OUTSIDE_MODEL_PEOPLE: people,
});

/** Whether the carve-out admits `personId`'s own call in `businessId` under the listed pairs. */
const admits = (people: readonly string[], businessId: string, personId: string): boolean =>
  carriesOutside({ installation: 'here', outsidePeople: people }, ROUTES[1], {
    businessId,
    operation: { key: 'model.conversation_answer_openrouter', provider: 'openrouter' },
    caller: { actorId: actor, delegationId: null, attendedByPersonId: personId },
    fieldNames: ['message'],
    authors: [actor],
  });

describe('the outside people setting', () => {
  it.each([
    ['ids in upper case', PAIR.toUpperCase()],
    ['spaces and tabs around the pairs', ` \t${PAIR} ,\t${PAIR.toUpperCase()} `],
    ['a pair listed twice', `${PAIR},${PAIR.toUpperCase()}`],
  ])(
    '%s: the same pairs to the root and the commands, and only those admitted',
    (_name, people) => {
      const read = brokerSettings(environment(people));
      expect(read).toMatchObject({ kind: 'configured' });
      const listed = read.kind === 'configured' ? read.outsidePeople : [];
      expect(new Set(listed)).toStrictEqual(new Set([PAIR]));
      expect(new Set(outsidePeopleOf(environment(people)))).toStrictEqual(new Set([PAIR]));
      expect(admits(listed, business, person)).toBe(true);
      expect(admits(listed, business.toUpperCase(), person.toUpperCase())).toBe(true);
      expect(admits(listed, otherBusiness, person)).toBe(false);
      expect(admits(listed, person, business)).toBe(false);
      expect(admits(listed, business, randomUUID())).toBe(false);
    },
  );

  it('a pair for another business admits nobody here, though the person is the same', () => {
    const read = brokerSettings(environment(`${otherBusiness}:${person}`));
    const listed = read.kind === 'configured' ? read.outsidePeople : [];
    expect(listed).toHaveLength(1);
    expect(admits(listed, business, person)).toBe(false);
    expect(outsidePeopleOf(environment(`${otherBusiness}:${person}`))).not.toContain(PAIR);
  });

  it.each([
    ['a space inside a pair', `${business} : ${person}`],
    ['an empty entry', `${PAIR},,${otherBusiness}:${person}`],
    ['a trailing comma', `${PAIR},`],
    ['a newline between pairs', `${PAIR}\n${otherBusiness}:${person}`],
    ['a semicolon between pairs', `${PAIR};${otherBusiness}:${person}`],
    ['braces around an id', `{${business}}:${person}`],
  ])('%s stops the server', (_name, people) => {
    expect(brokerSettings(environment(people)).kind).toBe('invalid');
  });

  it('a provider in another case stops the server, and the commands list nobody', () => {
    expect(brokerSettings(environment(PAIR, 'OpenRouter')).kind).toBe('invalid');
    expect(outsidePeopleOf(environment(PAIR, 'OpenRouter'))).toStrictEqual([]);
  });
});
