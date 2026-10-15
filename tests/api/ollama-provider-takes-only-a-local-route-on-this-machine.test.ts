// SPDX-License-Identifier: AGPL-3.0-only
//
// `OPS_AGENT_PROVIDER=ollama`: the install's chat runs on Ollama on this
// machine. The composition root takes it in any environment, but only over a
// local route whose destination is this machine's loopback address: Ollama is
// never reached over the network, and its route is never cloud. The install's
// conversation provider, and so the picker's models, follow the same setting.

import { expect, it } from 'vitest';
import { brokerSettings } from '../../apps/api/model-broker.ts';
import {
  conversationModelsOf,
  conversationProviderOf,
  OLLAMA_PROVIDER,
} from '../../packages/core-connectors/src/index.ts';

const CANARY = 'canary-4b8e21d0';

const route = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  key: 'm5_ollama',
  reach: 'local',
  provider: OLLAMA_PROVIDER,
  credentialRef: 'ollama_key',
  credentialKind: 'api_key',
  installation: 'here',
  ceiling: 2,
  ...overrides,
});

const settingsWith = (
  origin: string,
  routes: readonly unknown[] = [route()],
): Readonly<Record<string, string>> => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_CREDENTIALS_FILE: '/run/broker/credentials.json',
  MODEL_BROKER_DESTINATIONS: JSON.stringify([{ key: 'ollama', origin }]),
  MODEL_BROKER_ROUTES: JSON.stringify(routes),
  MODEL_BROKER_INSTALLATION: 'here',
});

it('takes a local Ollama route on loopback, in any environment', () => {
  for (const environment of [undefined, 'local', 'staging', 'production']) {
    const settings = brokerSettings({
      ...settingsWith('http://127.0.0.1:11434'),
      ...(environment === undefined ? {} : { OPS_ENVIRONMENT: environment }),
    });
    expect(settings, String(environment)).toMatchObject({
      kind: 'configured',
      provider: 'ollama',
      routes: [{ provider: OLLAMA_PROVIDER, reach: 'local' }],
    });
  }
});

it('refuses an Ollama destination off this machine, never echoing it', () => {
  for (const origin of [`https://${CANARY}.example`, `http://${CANARY}.example:11434`]) {
    const settings = brokerSettings(settingsWith(origin));
    expect(settings.kind, origin).toBe('invalid');
    if (settings.kind === 'invalid') expect(settings.problem).not.toContain(CANARY);
  }
});

it('refuses an Ollama route that says cloud', () => {
  const settings = brokerSettings(
    settingsWith('http://127.0.0.1:11434', [route({ reach: 'cloud' })]),
  );
  expect(settings).toMatchObject({ kind: 'invalid' });
});

it('needs the broker settings, as local-gpt does', () => {
  expect(brokerSettings({ OPS_AGENT_PROVIDER: 'ollama' })).toMatchObject({ kind: 'invalid' });
});

it('makes Ollama the conversation provider, offering the Qwen MoE first, then Qwen and Gemma, all local and free', () => {
  expect(conversationProviderOf({ OPS_AGENT_PROVIDER: 'ollama' })).toBe(OLLAMA_PROVIDER);
  expect(
    conversationProviderOf({ OPS_AGENT_PROVIDER: 'ollama', OPS_ENVIRONMENT: 'production' }),
  ).toBe(OLLAMA_PROVIDER);
  const models = conversationModelsOf(OLLAMA_PROVIDER);
  expect(models.map((model) => model.id)).toStrictEqual([
    'qwen3.6:35b-mlx',
    'qwen3.6:27b-mlx',
    'gemma4:31b-mlx',
  ]);
  for (const model of models) {
    expect(model).toMatchObject({ provider: OLLAMA_PROVIDER, reach: 'local', ceilingMinor: 0 });
    // No client's model-egress setting names it: a client's conversation is offered neither.
    expect(model.egressName).toBeNull();
  }
});
