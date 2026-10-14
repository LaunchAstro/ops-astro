// SPDX-License-Identifier: AGPL-3.0-only
//
// The API refuses to start on a loose outside-provider setting, naming the
// setting and never its value: a provider other than openrouter, a people list
// empty, malformed or set with the provider off, no openrouter route, one that
// is not a cloud API key route, and a destination that is not exactly
// https://openrouter.ai with the decoded stream format. Unset, no OpenRouter
// operation is registered; set well, it is, for the listed people.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import { catalogueOf } from '../../apps/api/broker-catalogue.ts';

const business = randomUUID();
const person = randomUUID();
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
];
const DESTINATIONS = [
  { key: 'ollama', origin: 'http://127.0.0.1:11434' },
  { key: 'openrouter', origin: 'https://openrouter.ai', stream: 'openai_sse' },
];

const settings = (over: Record<string, string | undefined> = {}) =>
  brokerSettings({
    OPS_AGENT_PROVIDER: 'ollama',
    MODEL_BROKER_CREDENTIALS_FILE: '/nowhere/credentials.json',
    MODEL_BROKER_DESTINATIONS: JSON.stringify(DESTINATIONS),
    MODEL_BROKER_ROUTES: JSON.stringify(ROUTES),
    MODEL_BROKER_INSTALLATION: 'here',
    OPS_OUTSIDE_PROVIDER: 'openrouter',
    OPS_OUTSIDE_MODEL_PEOPLE: PAIR,
    ...over,
  });

const withRoute = (change: Record<string, unknown>) =>
  JSON.stringify([ROUTES[0], { ...ROUTES[1], ...change }]);
const withDestination = (change: Record<string, unknown>) =>
  JSON.stringify([DESTINATIONS[0], { ...DESTINATIONS[1], ...change }]);

// oxlint-disable-next-line max-lines-per-function -- each loose setting, then set and unset
describe('the outside provider setting', () => {
  it.each([
    ['a provider other than openrouter', { OPS_OUTSIDE_PROVIDER: 'anthropic' }],
    ['an empty people list', { OPS_OUTSIDE_MODEL_PEOPLE: '' }],
    ['a malformed people list', { OPS_OUTSIDE_MODEL_PEOPLE: `${PAIR},nathan` }],
    ['a people list with the provider off', { OPS_OUTSIDE_PROVIDER: undefined }],
    ['no openrouter route', { MODEL_BROKER_ROUTES: JSON.stringify([ROUTES[0]]) }],
    ['an openrouter route that is local', { MODEL_BROKER_ROUTES: withRoute({ reach: 'local' }) }],
    [
      'an openrouter subscription route',
      { MODEL_BROKER_ROUTES: withRoute({ credentialKind: 'subscription' }) },
    ],
    [
      'another origin',
      {
        MODEL_BROKER_DESTINATIONS: withDestination({
          origin: 'https://openrouter.ai.example.test',
        }),
      },
    ],
    ['no declared stream', { MODEL_BROKER_DESTINATIONS: withDestination({ stream: undefined }) }],
    [
      'an unknown stream format',
      { MODEL_BROKER_DESTINATIONS: withDestination({ stream: 'ndjson' }) },
    ],
  ])('%s stops the server, naming no value', (_name, over) => {
    const read = settings(over);
    expect(read.kind).toBe('invalid');
    const problem = read.kind === 'invalid' ? read.problem : '';
    expect(problem).not.toContain(person);
    expect(problem).not.toContain('example.test');
  });

  it('set well: configured, with the listed people and the OpenRouter operation', () => {
    const read = settings();
    expect(read).toMatchObject({ kind: 'configured', outsidePeople: [PAIR] });
    expect(catalogueOf('ollama', true).operations.has('model.conversation_answer_openrouter')).toBe(
      true,
    );
  });

  it('unset: configured with nobody listed and no OpenRouter operation or route', () => {
    const read = settings({
      OPS_OUTSIDE_PROVIDER: undefined,
      OPS_OUTSIDE_MODEL_PEOPLE: undefined,
      MODEL_BROKER_ROUTES: JSON.stringify([ROUTES[0]]),
    });
    expect(read).toMatchObject({ kind: 'configured', outsidePeople: [] });
    expect(
      catalogueOf('ollama', false).operations.has('model.conversation_answer_openrouter'),
    ).toBe(false);
    expect(
      settings({ OPS_OUTSIDE_PROVIDER: undefined, OPS_OUTSIDE_MODEL_PEOPLE: undefined }).kind,
    ).toBe('invalid');
  });
});
