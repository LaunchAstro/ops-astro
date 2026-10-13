// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's settings for the owner's ChatGPT plan (#1620): all three
// or none, the Responses address exactly `https://api.openai.com` and the
// sign-in address exactly `https://auth.openai.com`. Custody's destinations
// then hold the plan's Responses address, folded whole, and the sign-in
// address, which takes no caller's POST.

import { describe, expect, it } from 'vitest';
import { destinationsOf } from '../../apps/model-agent/main.ts';
import {
  CHATGPT_PLAN_ORIGIN,
  CHATGPT_SIGN_IN_ORIGIN,
  parseAgentSettings,
} from '../../apps/model-agent/settings.ts';
import { carryKey } from './model-agent-world.ts';

describe("the plan's settings name only the plan's own addresses", () => {
  const base = {
    business: '11111111-1111-4111-8111-111111111111',
    agent: '22222222-2222-4222-8222-222222222222',
    gotrueUrl: 'http://127.0.0.1:9999',
    email: 'agent@example.test',
    password: 'agent-password',
    providerKey: 'anon',
    realtimeUrl: 'ws://127.0.0.1:4000',
    carryKey: carryKey(),
    ollamaOrigin: 'http://127.0.0.1:11434',
    credentialsFile: '/tmp/credentials.json',
    credentialRef: 'ollama_local',
  };
  const plan = {
    chatgptCredentialRef: 'chatgpt_plan',
    chatgptOrigin: CHATGPT_PLAN_ORIGIN,
    chatgptSignInOrigin: CHATGPT_SIGN_IN_ORIGIN,
  };

  it('control: the base settings and the plan settings both read', () => {
    expect(parseAgentSettings(JSON.stringify(base)).ok).toBe(true);
    const read = parseAgentSettings(JSON.stringify({ ...base, ...plan }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(destinationsOf(read.settings)).toContainEqual({
      key: 'chatgpt_plan',
      origin: 'https://api.openai.com',
      stream: 'responses_sse',
    });
    expect(destinationsOf(read.settings)).toContainEqual({
      key: 'chatgpt_sign_in',
      origin: 'https://auth.openai.com',
      post: false,
    });
  });

  it.each([
    ['another Responses address', { ...plan, chatgptOrigin: 'https://chatgpt.com' }],
    ['another sign-in address', { ...plan, chatgptSignInOrigin: 'http://127.0.0.1:1455' }],
    ['the reference alone', { chatgptCredentialRef: 'chatgpt_plan' }],
    ['the addresses alone', { chatgptOrigin: CHATGPT_PLAN_ORIGIN }],
  ])('settings with %s are refused', (_what, extra) => {
    expect(parseAgentSettings(JSON.stringify({ ...base, ...extra })).ok).toBe(false);
  });
});
