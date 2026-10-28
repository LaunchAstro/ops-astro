// SPDX-License-Identifier: AGPL-3.0-only
//
// #2270: the model agent's Hermes Agent settings go together, custody's
// credential reference and Hermes Agent's address, which must be exactly its
// API server on this machine's loopback.

import { describe, expect, it } from 'vitest';
import { parseAgentSettings } from '../../apps/model-agent/settings.ts';
import { carryKey } from './model-agent-world.ts';

const settings = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    business: '7d6f6c1e-8a51-4c43-9a3f-0b8f3c2d9e10',
    agent: '0c5b9a4e-2f1d-4e6b-8c7a-9d3e1f2a4b5c',
    gotrueUrl: 'https://project.supabase.co/auth/v1',
    email: 'm5-models@example.test',
    password: 'a-long-agent-password',
    providerKey: 'sb_publishable_example',
    realtimeUrl: 'wss://project.supabase.co/realtime/v1',
    carryKey: carryKey(),
    ollamaOrigin: 'http://127.0.0.1:11434',
    credentialsFile: '/var/lib/model-agent/credentials.json',
    credentialRef: 'ollama_key',
    ...over,
  });

describe('the agent’s Hermes settings', () => {
  it('go together, the address exactly Hermes Agent’s on loopback', () => {
    const both = { hermesCredentialRef: 'hermes', hermesOrigin: 'http://127.0.0.1:8642' };
    expect(parseAgentSettings(settings(both)).ok).toBe(true);
    expect(parseAgentSettings(settings()).ok).toBe(true);
    for (const over of [
      { hermesCredentialRef: 'hermes' },
      { hermesOrigin: 'http://127.0.0.1:8642' },
      { ...both, hermesCredentialRef: '' },
      { ...both, hermesOrigin: 'http://127.0.0.1:8643' },
      { ...both, hermesOrigin: 'http://localhost:8642' },
      { ...both, hermesOrigin: 'https://127.0.0.1:8642' },
      { ...both, hermesOrigin: 'http://192.168.1.20:8642' },
      { ...both, hermesOrigin: 'http://127.0.0.1:8642/v1' },
    ]) {
      expect(parseAgentSettings(settings(over)), JSON.stringify(over)).toMatchObject({ ok: false });
    }
  });
});
