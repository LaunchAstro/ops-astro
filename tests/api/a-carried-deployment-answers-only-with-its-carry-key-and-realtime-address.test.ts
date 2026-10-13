// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment (`MODEL_BROKER_CARRIER`) answers its conversations
// through the model agent, over Realtime, and holds no provider credential.
// It starts only with what carriage needs: a carry key that is well formed
// (and, during a rotation, a next one), a secure Realtime address, and the
// project's publishable key. Missing or malformed, the function does not
// start, naming the setting and never its value. With them, its exchange is
// the carried one.

import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { carriedAnswers } from '../../apps/api/model-carriage.ts';
import { carrierSettings } from '../../apps/api/model-carrier.ts';

const KEY = randomBytes(32).toString('base64url');
const ROUTE = JSON.stringify([
  {
    key: 'm5_ollama',
    reach: 'local',
    provider: 'ollama',
    credentialRef: 'carried',
    credentialKind: 'api_key',
    installation: 'here',
    ceiling: 1,
  },
]);

const settings = (over: Record<string, string | undefined> = {}) => ({
  OPS_AGENT_PROVIDER: 'ollama',
  MODEL_BROKER_ROUTES: ROUTE,
  MODEL_BROKER_INSTALLATION: 'here',
  MODEL_BROKER_CARRIER: JSON.stringify({ agent: randomUUID(), people: [randomUUID()] }),
  MODEL_BROKER_CARRY_KEY: KEY,
  SUPABASE_REALTIME_URL: 'wss://project.supabase.co/realtime/v1',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  ...over,
});

const answersFor = (environment: Record<string, string | undefined>) => {
  const carried = carrierSettings(environment);
  if (carried.kind !== 'carried') throw new Error(`carrier ${carried.kind}`);
  return carriedAnswers(environment, carried);
};

describe('a carried deployment starts only with what carriage needs', () => {
  it('with a carry key, a secure Realtime address and the publishable key, it answers', () => {
    expect(typeof answersFor(settings()).answerConversation).toBe('function');
    const next = randomBytes(32).toString('base64url');
    expect(
      typeof answersFor(settings({ MODEL_BROKER_CARRY_KEY_NEXT: next })).answerConversation,
    ).toBe('function');
  });

  it.each([
    ['no carry key', { MODEL_BROKER_CARRY_KEY: undefined }, /MODEL_BROKER_CARRY_KEY/u],
    ['a short carry key', { MODEL_BROKER_CARRY_KEY: 'c2hvcnQ' }, /MODEL_BROKER_CARRY_KEY/u],
    [
      'a next key the same as the key',
      { MODEL_BROKER_CARRY_KEY_NEXT: KEY },
      /MODEL_BROKER_CARRY_KEY/u,
    ],
    ['no Realtime address', { SUPABASE_REALTIME_URL: undefined }, /SUPABASE_REALTIME_URL/u],
    [
      'an address that is not wss',
      { SUPABASE_REALTIME_URL: 'ws://project.supabase.co/realtime/v1' },
      /SUPABASE_REALTIME_URL/u,
    ],
    ['no publishable key', { SUPABASE_PUBLISHABLE_KEY: undefined }, /SUPABASE_PUBLISHABLE_KEY/u],
  ])('refuses to start with %s, naming the setting and never a key', (_name, over, named) => {
    let thrown = '';
    try {
      answersFor(settings(over));
    } catch (error) {
      thrown = String(error);
    }
    expect(thrown).toMatch(named);
    expect(thrown).not.toContain(KEY);
  });
});
