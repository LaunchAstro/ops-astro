// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent sends Ollama one thing: a streamed chat with an offered
// model, to `/api/chat`, by POST, on loopback. A sealed request for anything
// else (a pull, a delete, another method or destination, `stream: false`,
// thinking on, an extra key, a model not offered, a longer wait or a larger
// answer than the catalogue's) is refused sealed and asks Ollama nothing. An
// Ollama address off this machine is refused at start.

import { afterEach, describe, expect, it } from 'vitest';
import { parseAgentSettings } from '../../apps/model-agent/settings.ts';
import { carryKey, chatRequest, openAgentWorld, type AgentWorld } from './model-agent-world.ts';
import type { OutboundRequest } from '../../packages/core-custody/src/agent.ts';

const WAIT = 15_000;

let world: AgentWorld | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

const refused: readonly [string, OutboundRequest][] = [
  ['a model pull', chatRequest({}, { path: '/api/pull' })],
  ['a model delete', chatRequest({}, { path: '/api/delete', method: 'DELETE' as 'POST' })],
  ['another method', chatRequest({}, { method: 'PUT' })],
  ['another destination', chatRequest({}, { destination: 'openai' })],
  ['an answer not streamed', chatRequest({ stream: false })],
  ['thinking on', chatRequest({ think: true })],
  ['an extra key', chatRequest({ keep_alive: -1 })],
  ['a model not offered', chatRequest({ model: 'llama3:70b' })],
  ['a longer wait than the catalogue’s', chatRequest({}, { timeoutMs: 3_600_000 })],
  ['a larger answer than the catalogue’s', chatRequest({}, { maxResponseBytes: 64 * 1024 * 1024 })],
  ['a body that is not JSON', chatRequest({}, { body: 'model=qwen' })],
];

const settings = (ollamaOrigin: string): string =>
  JSON.stringify({
    business: '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10',
    agent: '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c',
    gotrueUrl: 'https://project.supabase.co/auth/v1',
    email: 'm5-models@example.test',
    password: 'a-long-agent-password',
    providerKey: 'sb_publishable_example',
    realtimeUrl: 'wss://project.supabase.co/realtime/v1',
    carryKey: carryKey(),
    ollamaOrigin,
    credentialsFile: '/var/lib/model-agent/credentials.json',
    credentialRef: 'ollama_key',
  });

describe('the request check', () => {
  it.each(refused)(
    '%s is refused sealed and asks Ollama nothing',
    async (_name, request) => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body(request)));
      const [answer] = await call.until('refused');
      expect(world.ollama.seen.length).toBe(0);
      expect(answer?.body).toStrictEqual({ code: 'REQUEST_REFUSED' });
      expect(world.handed).toStrictEqual([]);
    },
    WAIT,
  );

  it(
    'control: a streamed chat with an offered model is sent once',
    async () => {
      world = await openAgentWorld();
      const call = await world.call();
      await call.line.send('request', call.seal('request', call.body()));
      await call.until('answer');
      expect(world.ollama.seen.length).toBe(1);
    },
    WAIT,
  );
});

describe('the settings', () => {
  for (const origin of [
    'http://192.168.1.20:11434',
    'http://m5.local:11434',
    'https://127.0.0.1:11434',
    'http://127.0.0.1:11434/api',
    'http://0.0.0.0:11434',
  ]) {
    it(`refuses ${origin} for Ollama at start`, () => {
      const parsed = parseAgentSettings(settings(origin));
      expect(parsed.ok).toBe(false);
    });
  }

  it('control: Ollama on loopback starts', () => {
    expect(parseAgentSettings(settings('http://127.0.0.1:11434')).ok).toBe(true);
    expect(parseAgentSettings(settings('http://[::1]:11434')).ok).toBe(true);
  });

  it('refuses a malformed carry key or a missing field', () => {
    const good = JSON.parse(settings('http://127.0.0.1:11434')) as Record<string, unknown>;
    expect(parseAgentSettings(JSON.stringify({ ...good, carryKey: 'short' })).ok).toBe(false);
    expect(parseAgentSettings(JSON.stringify({ ...good, agent: undefined })).ok).toBe(false);
    expect(parseAgentSettings(JSON.stringify({ ...good, business: 'ALPHA' })).ok).toBe(false);
  });
});
