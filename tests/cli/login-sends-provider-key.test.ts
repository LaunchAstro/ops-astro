// SPDX-License-Identifier: AGPL-3.0-only
//
// `pnpm cli login` against a hosted sign-in service, which refuses a password
// grant without the project's publishable key (`No API key found in
// request`). With `SUPABASE_PUBLISHABLE_KEY` set the command line sends it as
// `apikey`, as the web does (`withProviderKey`), and the token is saved;
// without it the refusal is GoTrue's own words and names the setting. The
// sign-in service here is a stand-in on a loopback port.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as cli } from '../../apps/cli/main.ts';
import { standInGoTrue, type StandIn } from '../support/stand-in-gotrue.ts';

const KEY = 'sb_publishable_login-test-only';
const TOKEN = 'login-bearer-canary-6d21';
const PASSWORD = 'login-password-canary-0f3a';

let gotrue: StandIn;
let folder: string;

beforeAll(async () => {
  gotrue = await standInGoTrue({
    issue: async () => await Promise.resolve(TOKEN),
    expiresIn: 3_600,
    key: KEY,
  });
  folder = mkdtempSync(join(tmpdir(), 'cli-login-key-'));
});

afterAll(async () => {
  await gotrue?.close();
  rmSync(folder, { recursive: true, force: true });
});

async function login(name: string, env: Record<string, string>) {
  const printed: string[] = [];
  const io = {
    out: (line: string) => printed.push(line),
    err: (line: string) => printed.push(line),
    stdin: async () => await Promise.resolve(''),
  };
  const tokenFile = join(folder, name);
  const code = await cli(
    ['login', '--email', 'agent@example.test'],
    {
      OPS_ASTRO_GOTRUE_URL: gotrue.url,
      OPS_ASTRO_PASSWORD: PASSWORD,
      OPS_ASTRO_TOKEN_FILE: tokenFile,
      ...env,
    },
    io,
  );
  return { code, printed: printed.join('\n'), tokenFile };
}

describe('cli login sends the publishable key to a hosted sign-in service', () => {
  it('with SUPABASE_PUBLISHABLE_KEY set, it signs in and saves the token, owner-only', async () => {
    const { code, printed, tokenFile } = await login('keyed', { SUPABASE_PUBLISHABLE_KEY: KEY });
    expect(code).toBe(0);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(gotrue.signIns()).toBe(1);
    for (const secret of [TOKEN, PASSWORD]) expect(printed.includes(secret)).toBe(false);
  });

  it('without it, the refusal is clear, names the setting and saves nothing', async () => {
    const { code, printed, tokenFile } = await login('keyless', {});
    expect(code).toBe(1);
    expect(printed).toContain('No API key found in request');
    expect(printed).toContain('SUPABASE_PUBLISHABLE_KEY');
    expect(() => statSync(tokenFile)).toThrow();
    expect(printed.includes(PASSWORD)).toBe(false);
  });
});
