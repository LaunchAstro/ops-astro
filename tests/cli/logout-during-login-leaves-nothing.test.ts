// SPDX-License-Identifier: AGPL-3.0-only
//
// A `logout` that completes while a `login` waits for its grant wins: the
// login saves nothing and says so. A login that starts after the logout saves
// as usual.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { latch, run, standIn } from './preset-stand-in.ts';

const ISSUER = 'https://issuer.example.test/auth/v1';

let folder: string;
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-logout-race-'));
  env = {
    OPS_ASTRO_GOTRUE_URL: ISSUER,
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-only',
    OPS_ASTRO_PASSWORD: 'race-password',
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

describe('logout during a login', () => {
  it('the login held at its grant saves nothing once a logout has completed', async () => {
    const held = latch();
    const granting = latch();
    vi.stubGlobal(
      'fetch',
      standIn(async () => {
        granting.open();
        await held.promise;
        return Response.json({ access_token: 'late-bearer' });
      }).fetch,
    );
    const login = run(['login', '--email', 'a@example.test'], env);
    await granting.promise;
    const logout = await run(['logout'], env);
    expect(logout.code, logout.err).toBe(0);
    held.open();
    const late = await login;
    expect(late.code).toBe(1);
    expect(late.err).toContain('signed out while signing in; nothing saved');
    expect(existsSync(join(folder, 'token'))).toBe(false);
  });

  it('a login that starts after the logout saves', async () => {
    vi.stubGlobal('fetch', standIn(() => Response.json({ access_token: 'after-bearer' })).fetch);
    expect((await run(['logout'], env)).code).toBe(0);
    const login = await run(['login', '--email', 'a@example.test'], env);
    expect(login.code, login.err).toBe(0);
    expect(existsSync(join(folder, 'token'))).toBe(true);
  });
});
