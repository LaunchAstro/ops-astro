// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-AUTHORITY-69: a key file named in the real
// environment is not shadowed by the checkout's own keyring.
//
// `localEnvironment()` in `apps/api/server.ts` reads `.local/delegation.env`,
// and the composition root copies its two settings into the process
// environment. `configuredCredentialKeys` never consults
// `DELEGATION_CREDENTIAL_KEY_FILE` once either explicit setting is present
// (`credential-keys.ts`), so a harness or deployment naming a key file would
// mint under the checkout's key instead. The checkout file here is the one the
// product itself creates on first start (`ensureCredentialKeyFile` on
// `LOCAL_KEY_FILE`), which is also what every server-spawning suite does.

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { localEnvironment } from '../../apps/api/server.ts';
import {
  ACTIVE_KEY_VARIABLE,
  ensureCredentialKeyFile,
  KEY_FILE_VARIABLE,
  KEYRING_VARIABLE,
  LOCAL_KEY_FILE,
} from '../../packages/core-records/src/authority/credential-keys.ts';

beforeAll(() => {
  const decision = ensureCredentialKeyFile(LOCAL_KEY_FILE);
  if (!decision.ok) throw new Error(`the checkout keyring is malformed: ${decision.problem}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('R2-AUTHORITY-69: the checkout keyring and a named key file', () => {
  it('does not carry .local/delegation.env when the real environment names a key file', () => {
    vi.stubEnv(KEY_FILE_VARIABLE, '/nonexistent/fr2-api-delegation-keys.json');
    vi.stubEnv(ACTIVE_KEY_VARIABLE, undefined);
    vi.stubEnv(KEYRING_VARIABLE, undefined);

    const environment = localEnvironment();

    expect(environment[ACTIVE_KEY_VARIABLE]).toBeUndefined();
    expect(environment[KEYRING_VARIABLE]).toBeUndefined();
    expect(environment[KEY_FILE_VARIABLE]).toBe('/nonexistent/fr2-api-delegation-keys.json');
  });

  it('still carries .local/delegation.env when no key file is named (control)', () => {
    vi.stubEnv(KEY_FILE_VARIABLE, undefined);
    vi.stubEnv(ACTIVE_KEY_VARIABLE, undefined);
    vi.stubEnv(KEYRING_VARIABLE, undefined);

    const environment = localEnvironment();

    expect(environment[ACTIVE_KEY_VARIABLE]).toMatch(/^local\/delegation-credential@/u);
    expect(environment[KEYRING_VARIABLE]).toContain(environment[ACTIVE_KEY_VARIABLE] as string);
  });

  it('lets an explicit key id in the real environment win over both (control)', () => {
    vi.stubEnv(KEY_FILE_VARIABLE, '/nonexistent/fr2-api-delegation-keys.json');
    vi.stubEnv(ACTIVE_KEY_VARIABLE, 'explicit/key');
    vi.stubEnv(KEYRING_VARIABLE, undefined);

    expect(localEnvironment()[ACTIVE_KEY_VARIABLE]).toBe('explicit/key');
  });
});
