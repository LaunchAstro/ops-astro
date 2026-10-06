// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1 (#859): the per-install provider setting and the `local-gpt`
// adapter. `OPS_AGENT_PROVIDER` unset or `api` is the broker exactly as
// AW-01 built it; `local-gpt` runs only where `OPS_ENVIRONMENT` is
// `local`, and a refusal names the setting, never its value. The adapter
// sends the runner a model and the fields and no credential; the answer is
// read against its schema; the price is always nothing, because the local
// mode spends no money (its API-equivalent cost is the runner's ledger).

import { expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import {
  catalogue,
  CONVERSATION_ANSWER,
  LOCAL_GPT_COMPOSE,
  LOCAL_GPT_CONVERSATION,
  LOCAL_GPT_DEFAULT_MODEL,
  LOCAL_GPT_NOTHING_HAPPENED,
  LOCAL_GPT_PATH,
  localGptAdapter,
  localGptCostMinor,
  readLocalGptAnswer,
} from '../../packages/core-connectors/src/index.ts';

const CANARY = 'canary-4b9e2a71c0';

const route = (provider: string, credentialKind = 'subscription') => ({
  key: 'local_gpt',
  reach: provider === 'local_gpt' ? 'cloud' : 'local',
  provider,
  credentialRef: 'local_runner',
  credentialKind,
  installation: 'here',
  ceiling: 2,
});

const broker = (routes: unknown[]) => ({
  MODEL_BROKER_CREDENTIALS_FILE: '/run/broker/credentials.json',
  MODEL_BROKER_DESTINATIONS: JSON.stringify([
    { key: 'replay', origin: 'http://127.0.0.1:9' },
    { key: 'local_gpt', origin: 'http://127.0.0.1:10' },
  ]),
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
  MODEL_BROKER_INSTALLATION: 'here',
});

const LOCAL_GPT = { ...broker([route('local_gpt')]), OPS_AGENT_PROVIDER: 'local-gpt' };

const problemOf = (environment: Readonly<Record<string, string | undefined>>): string => {
  const settings = brokerSettings(environment);
  if (settings.kind !== 'invalid') throw new Error(`expected invalid, got ${settings.kind}`);
  return settings.problem;
};

it('LA-1 provider setting: unset or api is the broker as AW-01 built it', () => {
  const replay = broker([route('replay', 'replay')]);
  for (const provider of [undefined, '', 'api']) {
    expect(brokerSettings({ ...replay, OPS_AGENT_PROVIDER: provider })).toMatchObject({
      kind: 'configured',
      provider: 'api',
    });
  }
  expect(brokerSettings({})).toEqual({ kind: 'absent' });
});

it('LA-1 provider setting: under api, a local-gpt route is not a known provider', () => {
  const problem = problemOf({ ...LOCAL_GPT, OPS_AGENT_PROVIDER: 'api' });
  expect(problem).toContain('MODEL_BROKER_ROUTES');
});

it('LA-1 provider setting: local-gpt is the broker where OPS_ENVIRONMENT is local', () => {
  expect(brokerSettings({ ...LOCAL_GPT, OPS_ENVIRONMENT: 'local' })).toMatchObject({
    kind: 'configured',
    provider: 'local-gpt',
    routes: [{ key: 'local_gpt', provider: 'local_gpt', credentialKind: 'subscription' }],
  });
});

it.each([
  ['unset', undefined],
  ['staging', 'staging'],
  ['hosted', 'hosted'],
  ['production', 'production'],
  ['a near miss', 'Local'],
])('LA-1 local-only refusal: local-gpt with OPS_ENVIRONMENT %s is refused by name', (_how, env) => {
  const problem = problemOf({ ...LOCAL_GPT, OPS_ENVIRONMENT: env });
  expect(problem).toContain('OPS_AGENT_PROVIDER');
  expect(problem).toContain('OPS_ENVIRONMENT');
});

it('LA-1 provider setting: a GPT route labelled local is refused, since GPT is a cloud model', () => {
  const labelled = broker([{ ...route('local_gpt'), reach: 'local' }]);
  const problem = problemOf({
    ...labelled,
    OPS_AGENT_PROVIDER: 'local-gpt',
    OPS_ENVIRONMENT: 'local',
  });
  expect(problem).toContain('MODEL_BROKER_ROUTES');
});

it("LA-1 provider setting: the GPT runner's destination must be this machine's loopback address", () => {
  const offMachine = {
    ...broker([route('local_gpt')]),
    MODEL_BROKER_DESTINATIONS: JSON.stringify([
      { key: 'local_gpt', origin: 'https://runner.example' },
    ]),
  };
  const problem = problemOf({
    ...offMachine,
    OPS_AGENT_PROVIDER: 'local-gpt',
    OPS_ENVIRONMENT: 'local',
  });
  expect(problem).toContain('loopback');
});

it('LA-1 provider setting: local-gpt with no broker settings is refused, not ignored', () => {
  const problem = problemOf({ OPS_AGENT_PROVIDER: 'local-gpt', OPS_ENVIRONMENT: 'local' });
  expect(problem).toContain('OPS_AGENT_PROVIDER');
});

it('LA-1 provider setting: an unknown provider is refused by the setting, never its value', () => {
  const problem = problemOf({ ...LOCAL_GPT, OPS_AGENT_PROVIDER: CANARY });
  expect(problem).toContain('OPS_AGENT_PROVIDER');
  expect(problem).not.toContain(CANARY);
});

it('LA-1 adapter: the runner is asked for GPT with the fields, and no origin or credential', () => {
  const built = localGptAdapter({ message: 'hello' });
  expect(built).toEqual({
    path: LOCAL_GPT_PATH,
    method: 'POST',
    body: JSON.stringify({ model: LOCAL_GPT_DEFAULT_MODEL, fields: { message: 'hello' } }),
  });
  expect(LOCAL_GPT_DEFAULT_MODEL).toBe('gpt-6.1-sol');
  expect(built.path.startsWith('/')).toBe(true);
});

it('LA-1 answer: the contract is read, and anything out of shape is no answer', () => {
  const good = {
    text: 'Hi.',
    model: 'gpt-6.1-sol',
    usage: { input: 12, output: 3 },
    code: null,
  };
  expect(readLocalGptAnswer(good)).toEqual({
    text: 'Hi.',
    model: 'gpt-6.1-sol',
    usage: { inputUnits: 12, outputUnits: 3 },
    providerCode: null,
  });
  expect(readLocalGptAnswer({ ...good, code: 'LOCAL_CAP_REACHED' })?.providerCode).toBe(
    'LOCAL_CAP_REACHED',
  );
  for (const bad of [
    null,
    [],
    'text',
    { ...good, text: 7 },
    { ...good, usage: 'lots' },
    { ...good, usage: { input: -1, output: 3 } },
    { ...good, code: 9 },
    { ...good, usage: { input: 1.5, output: 3 } },
    { ...good, model: 'gpt; drop table model_calls' },
  ]) {
    expect(readLocalGptAnswer(bad)).toBeUndefined();
  }
});

it('LA-1 price: a local answer costs nothing, however many tokens it used', () => {
  const answer = readLocalGptAnswer({
    text: 'Long.',
    model: 'gpt-6.1-sol',
    usage: { input: 400_000, output: 300_000 },
    code: null,
  });
  expect(answer).toBeDefined();
  if (answer !== undefined) expect(localGptCostMinor(answer)).toBe(0);
});

it('LA-1 operations: both register with all twelve declarations, on the local_gpt destination', () => {
  const operations = catalogue([LOCAL_GPT_COMPOSE, LOCAL_GPT_CONVERSATION]);
  for (const operation of operations.values()) {
    expect(operation).toMatchObject({ provider: 'local_gpt', destination: 'local_gpt' });
    expect(operation.nothingHappened).toEqual(LOCAL_GPT_NOTHING_HAPPENED);
  }
  // The conversation seam asks for the conversation operation by its one key;
  // under local-gpt the catalogue answers it with the local declaration.
  expect(LOCAL_GPT_CONVERSATION.key).toBe(CONVERSATION_ANSWER.key);
  expect(LOCAL_GPT_CONVERSATION.fields).toEqual(CONVERSATION_ANSWER.fields);
  expect(LOCAL_GPT_NOTHING_HAPPENED).toEqual([
    'LOCAL_CAP_REACHED',
    'LOCAL_MODEL_NOT_APPROVED',
    'LOCAL_PLAN_LIMIT',
    'LOCAL_GPT_FAILED',
  ]);
});
