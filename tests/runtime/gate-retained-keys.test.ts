// SPDX-License-Identifier: AGPL-3.0-only
//
// Retired gate keys a read still verifies with (#2265).
//
// A business's decision chain outlives the key that signed its first links:
// staging's alpha holds seq 1-9 under `staging-gate-1` and seq 10-11 under
// `staging-gate-2`. `GATE_RETAINED_KEYS` names the retired keys beside the
// signing key, so the read verifies each row under the key its own row names.
// A retained key never signs, a malformed setting is refused with its reason,
// and the reason never carries a secret. The chain read itself is proved in
// `tests/reads/verified-decisions.test.ts`.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import {
  gateSigningKey,
  gateVerifyingKeys,
  runtimeKeys,
  runtimeKeysProblem,
  withRuntimeKeys,
} from '../../packages/core-runtime/src/index.ts';
import { TEST_ISSUER } from '../support/sign-in.ts';

const ROOT = join(import.meta.dirname, '..', '..');

const MARKER = 'retained-secret-marker-7f3a';
const signing = { GATE_SIGNING_KEY_ID: 'gate@2', GATE_SIGNING_SECRET: 'current-secret' };

function keysFor(retained: string | undefined) {
  return gateVerifyingKeys({ ...signing, GATE_RETAINED_KEYS: retained });
}

describe('retained gate keys', () => {
  it('resolves the signing key and each retained key by its own id, and nothing else', () => {
    const decision = keysFor(JSON.stringify([{ id: 'gate@1', secret: MARKER }]));
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.keys?.('gate@2')).toStrictEqual({ id: 'gate@2', secret: 'current-secret' });
    expect(decision.keys?.('gate@1')).toStrictEqual({ id: 'gate@1', secret: MARKER });
    expect(decision.keys?.('gate@0')).toBeUndefined();
  });

  it('leaves the signing key the only key that signs', () => {
    const settings = {
      ...signing,
      GATE_RETAINED_KEYS: JSON.stringify([{ id: 'gate@1', secret: MARKER }]),
    };
    expect(gateSigningKey(settings)).toStrictEqual({ id: 'gate@2', secret: 'current-secret' });
  });

  it('is the signing key alone when nothing is retained, and nothing when no key is configured', () => {
    for (const retained of [undefined, '', ' ']) {
      const decision = keysFor(retained);
      expect(decision.ok).toBe(true);
      if (!decision.ok) continue;
      expect(decision.keys?.('gate@2')?.id).toBe('gate@2');
      expect(decision.keys?.('gate@1')).toBeUndefined();
    }
    expect(gateVerifyingKeys({})).toStrictEqual({ ok: true, keys: null });
  });
});

describe('a refused retained gate key setting', () => {
  it.each([
    ['not JSON', `{"id":"gate@1","secret":"${MARKER}"`],
    ['not an array', JSON.stringify({ id: 'gate@1', secret: MARKER })],
    ['an entry that is not an object', JSON.stringify([MARKER])],
    ['an undeclared field', JSON.stringify([{ id: 'gate@1', secret: MARKER, [MARKER]: 1 }])],
    ['an empty id', JSON.stringify([{ id: '', secret: MARKER }])],
    ['a missing secret', JSON.stringify([{ id: 'gate@1' }])],
    ['an empty secret', JSON.stringify([{ id: 'gate@1', secret: '' }])],
    ['a secret that is not text', JSON.stringify([{ id: 'gate@1', secret: 7 }])],
    [
      'a repeated id',
      JSON.stringify([
        { id: 'gate@1', secret: MARKER },
        { id: 'gate@1', secret: `${MARKER}-b` },
      ]),
    ],
    ['the signing key id', JSON.stringify([{ id: 'gate@2', secret: MARKER }])],
    ['retained keys with no signing key', JSON.stringify([{ id: 'gate@1', secret: MARKER }])],
  ])('refuses %s, naming the setting and never the secret', (_case, retained) => {
    const settings =
      _case === 'retained keys with no signing key'
        ? { GATE_RETAINED_KEYS: retained }
        : { ...signing, GATE_RETAINED_KEYS: retained };
    const decision = gateVerifyingKeys(settings);
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.problem).toMatch(/^GATE_RETAINED_KEYS /u);
    expect(decision.problem).not.toContain(MARKER);
  });
});

describe('retained gate keys in a composition', () => {
  it('reads the handed-over keys inside a composition, not the process environment', () => {
    const keys = runtimeKeys({
      ...signing,
      GATE_RETAINED_KEYS: JSON.stringify([{ id: 'gate@1', secret: MARKER }]),
    });
    const outside = process.env['GATE_RETAINED_KEYS'];
    process.env['GATE_RETAINED_KEYS'] = 'not JSON';
    try {
      const decision = withRuntimeKeys(keys, () => gateVerifyingKeys());
      expect(decision.ok).toBe(true);
      if (!decision.ok) return;
      expect(decision.keys?.('gate@1')?.secret).toBe(MARKER);
    } finally {
      if (outside === undefined) delete process.env['GATE_RETAINED_KEYS'];
      else process.env['GATE_RETAINED_KEYS'] = outside;
    }
  });
});

describe('a composition root with a refused retained gate key setting', () => {
  const REFUSED = JSON.stringify([{ id: 'gate@2', secret: MARKER }]);
  const PROBLEM = 'gate keys: GATE_RETAINED_KEYS repeats the signing key id';
  /** Nothing listens here: neither entry reads a database before its keys. */
  const NOWHERE = 'postgres://app:retained@127.0.0.1:1/none';
  const START = {
    ...signing,
    DELEGATION_CREDENTIAL_KEY_ID: 'd@1',
    DELEGATION_CREDENTIAL_KEYS: `d@1:${'A'.repeat(43)}`,
    GATE_RETAINED_KEYS: REFUSED,
    DATABASE_URL: NOWHERE,
    DATABASE_ADMIN_URL: NOWHERE,
    GOTRUE_URL: TEST_ISSUER,
    SERVED_HOST: 'ops.example.test',
  };

  it('names the setting and never the secret, and only for the retained keys', () => {
    const keys = runtimeKeys(START);
    expect(keys.delegation.ok).toBe(true);
    expect(runtimeKeysProblem(keys)).toBe(PROBLEM);
    expect(
      runtimeKeysProblem({ ...keys, gateVerifying: { ok: true, keys: null } }),
    ).toBeUndefined();
  });

  it('the function does not start', () => {
    expect(() => createFunctionHandler(START)).toThrow(PROBLEM);
    expect(() => createFunctionHandler(START)).not.toThrow(MARKER);
  });

  it('the server exits at boot, before it reads its database', () => {
    // Were the check gone, the server would go on to its database, which nothing serves here,
    // and on port 0 never take a lane's port.
    const run = spawnSync(process.execPath, ['apps/api/server.ts'], {
      cwd: ROOT,
      env: { PATH: process.env['PATH'], ...START, API_PORT: '0' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect({ status: run.status, stderr: run.stderr }).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`api: ${PROBLEM}`),
    });
    expect(`${run.stdout}${run.stderr}`).not.toContain(MARKER);
  });
});
