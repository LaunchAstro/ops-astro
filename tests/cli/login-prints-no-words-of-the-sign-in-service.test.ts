// SPDX-License-Identifier: AGPL-3.0-only
//
// A refused `login` prints a fixed line of the command line's own, never the
// sign-in service's words, so an answer that echoes the password or the key
// back puts neither on the screen.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, standIn } from './preset-stand-in.ts';

const PASSWORD = 'echoed-password-canary-77ab';
const KEY = 'sb_publishable_echoed-key-canary';
const ISSUER = 'https://issuer.example.test/auth/v1';

let folder: string;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-login-words-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

async function refusedWith(status: number, field: string, keyed = true) {
  vi.stubGlobal(
    'fetch',
    standIn(() => Response.json({ [field]: `nope: ${PASSWORD} with ${KEY}` }, { status })).fetch,
  );
  return await run(['login', '--email', 'a@example.test'], {
    OPS_ASTRO_GOTRUE_URL: ISSUER,
    OPS_ASTRO_PASSWORD: PASSWORD,
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    ...(keyed ? { SUPABASE_PUBLISHABLE_KEY: KEY } : {}),
  });
}

describe('a refused login prints none of the sign-in service’s words', () => {
  for (const field of ['error_description', 'msg', 'message', 'error']) {
    it(`an echo in ${field} stays off the screen`, async () => {
      const { code, out, err } = await refusedWith(400, field);
      expect(code).toBe(1);
      expect(err).toContain('the email or password was not accepted');
      for (const secret of [PASSWORD, KEY, 'nope']) expect(`${out}${err}`).not.toContain(secret);
    });
  }

  it('any other status names the service and the status only', async () => {
    const { code, out, err } = await refusedWith(503, 'message');
    expect(code).toBe(1);
    expect(err).toContain('the sign-in service at https://issuer.example.test refused (HTTP 503)');
    for (const secret of [PASSWORD, KEY, 'nope']) expect(`${out}${err}`).not.toContain(secret);
  });

  it('a 401 with no key set names the setting', async () => {
    const { code, out, err } = await refusedWith(401, 'message', false);
    expect(code).toBe(1);
    expect(err).toContain('SUPABASE_PUBLISHABLE_KEY');
    for (const secret of [PASSWORD, 'nope']) expect(`${out}${err}`).not.toContain(secret);
  });
});
