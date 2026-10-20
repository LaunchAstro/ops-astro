// SPDX-License-Identifier: AGPL-3.0-only
//
// The model agent's settings for the `chatgpt-plan` route (#1620 P4): the
// plan's token file, the Responses address and the plan's issuer go
// together, and the two addresses are exactly `https://api.openai.com` and
// `https://auth.openai.com`. Anything else is refused at start, naming the
// field and never its value. With none of the three set the agent starts
// without the route.

import { describe, expect, it } from 'vitest';
import { parseAgentSettings } from '../../apps/model-agent/settings.ts';
import { carryKey } from './model-agent-world.ts';

const PLAN = {
  planTokenFile: '/var/lib/model-agent/plan/token.json',
  planOrigin: 'https://api.openai.com',
  planIssuer: 'https://auth.openai.com',
};

const settings = (plan: Record<string, unknown> = {}): string =>
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
    ...plan,
  });

/** Addresses a careless or hostile setting might put in an exact address's place. */
const lookalikes = (origin: string): readonly string[] => {
  const host = new URL(origin).host;
  return [
    `${origin}/`,
    `${origin}/v1`,
    `http://${host}`,
    `https://${host}:443`,
    `https://${host}:8443`,
    `https://${host}.`,
    `https://${host.toUpperCase()}`,
    `https://${host}.example.test`,
    `https://example.test`,
    `https://127.0.0.1`,
    ` ${origin}`,
    `${origin}#`,
    `${origin}?x=1`,
  ];
};

describe('the plan settings', () => {
  it('start with the three set and the addresses exact', () => {
    const parsed = parseAgentSettings(settings(PLAN));
    expect(parsed).toMatchObject({ ok: true, settings: PLAN });
  });

  it('control: the agent starts with none of them', () => {
    expect(parseAgentSettings(settings()).ok).toBe(true);
  });

  it.each(Object.keys(PLAN))('refuse %s set alone or left out', (field) => {
    const alone = parseAgentSettings(settings({ [field]: PLAN[field as keyof typeof PLAN] }));
    expect(alone.ok).toBe(false);
    const { [field]: _left, ...rest } = PLAN as Record<string, string>;
    expect(parseAgentSettings(settings(rest)).ok).toBe(false);
  });
});

describe('the plan addresses', () => {
  it.each([
    ...lookalikes(PLAN.planOrigin).map((value) => ['planOrigin', value]),
    ...lookalikes(PLAN.planIssuer).map((value) => ['planIssuer', value]),
    ['planOrigin', PLAN.planIssuer],
    ['planIssuer', PLAN.planOrigin],
  ])('refuse %s %j at start, naming the field only', (field, value) => {
    const parsed = parseAgentSettings(settings({ ...PLAN, [field]: value }));
    expect(parsed.ok).toBe(false);
    const problem = parsed.ok ? '' : parsed.problem;
    expect(problem).toContain(field);
    expect(problem).not.toContain(String(value).trim());
  });

  it('refuse an address carrying a user and password', () => {
    const url = new URL(PLAN.planOrigin);
    url.username = 'owner';
    url.password = 'a-pass';
    expect(parseAgentSettings(settings({ ...PLAN, planOrigin: url.href })).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['relative', 'plan/token.json'],
    ['not text', 7],
  ])('refuse a token file that is %s', (_how, planTokenFile) => {
    expect(parseAgentSettings(settings({ ...PLAN, planTokenFile })).ok).toBe(false);
  });
});
