// SPDX-License-Identifier: AGPL-3.0-only
//
// API-2 quota on the function target: each instance holds its own count, so
// the function hands every instance the installation's limits divided by the
// deployment's instance ceiling, `AGENT_QUOTA_INSTANCES` (10 unset). The
// instances together then stay within the limits one server holds. A
// malformed ceiling stops the entry, naming the setting.

import { randomBytes } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_LIMITS } from '../../apps/api/auth/agent-quota.ts';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { ISSUER } from './fixture.ts';

const composed: Record<string, unknown>[] = [];

vi.mock('../../apps/api/server.ts', async (original) => {
  const real = await original<typeof import('../../apps/api/server.ts')>();
  return {
    ...real,
    composeApi: (config: Record<string, unknown>) => {
      composed.push(config);
      return real.composeApi(config as never);
    },
  };
});

const KEY_ID = 'test/function-agent-quota@1';
const NOWHERE = 'postgres://app:quota-canary@127.0.0.1:1/none';
const settings = {
  DELEGATION_CREDENTIAL_KEY_ID: KEY_ID,
  DELEGATION_CREDENTIAL_KEYS: `${KEY_ID}:${randomBytes(32).toString('base64url')}`,
  DATABASE_URL: NOWHERE,
  DATABASE_LOOKUP_URL: NOWHERE,
  GOTRUE_URL: ISSUER,
  SERVED_HOST: 'ops.example.test',
};

beforeEach(() => {
  composed.length = 0;
});

const limitsOf = (): unknown => composed.at(-1)?.['agentLimits'];

it('API-2 quota on the function: each instance holds the limits divided by the instance ceiling', () => {
  createFunctionHandler({ ...settings, AGENT_QUOTA_INSTANCES: '4' });
  expect(limitsOf()).toEqual({
    requests: { credential: 30, person: 60, business: 150 },
    concurrent: { credential: 1, person: 2, business: 4 },
    exports: { credential: 500, person: 1000, business: 2500 },
    refused: 15,
  });
  // Unset, a ceiling of ten; never below one call of each.
  createFunctionHandler(settings);
  const unset = limitsOf() as typeof DEFAULT_AGENT_LIMITS;
  expect(unset.requests.business).toBe(DEFAULT_AGENT_LIMITS.requests.business / 10);
  expect(unset.concurrent.credential).toBe(1);
  for (const bad of ['0', '-2', 'ten', '1.5']) {
    expect(() => createFunctionHandler({ ...settings, AGENT_QUOTA_INSTANCES: bad }), bad).toThrow(
      'AGENT_QUOTA_INSTANCES',
    );
  }
});

it('API-2 quota on the function: an instance ceiling above the smallest limit is refused at start-up, so the shares never total more than one server holds', () => {
  const { requests, concurrent, exports, refused } = DEFAULT_AGENT_LIMITS;
  const all = [requests, concurrent, exports].flatMap((tiers) => Object.values(tiers));
  const smallest = Math.min(...all, refused);
  expect(() =>
    createFunctionHandler({ ...settings, AGENT_QUOTA_INSTANCES: String(smallest + 1) }),
  ).toThrow('AGENT_QUOTA_INSTANCES');
  for (const instances of [1, smallest]) {
    createFunctionHandler({ ...settings, AGENT_QUOTA_INSTANCES: String(instances) });
    const held = limitsOf() as typeof DEFAULT_AGENT_LIMITS;
    for (const level of ['requests', 'concurrent', 'exports'] as const) {
      for (const tier of ['credential', 'person', 'business'] as const) {
        expect(held[level][tier] * instances).toBeLessThanOrEqual(
          DEFAULT_AGENT_LIMITS[level][tier],
        );
      }
    }
    expect(held.refused * instances).toBeLessThanOrEqual(refused);
  }
  // Unset, the ceiling is one the smallest limit allows.
  createFunctionHandler(settings);
  expect((limitsOf() as typeof DEFAULT_AGENT_LIMITS).concurrent.credential).toBe(1);
});
