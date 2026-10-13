// SPDX-License-Identifier: AGPL-3.0-only
//
// `pnpm cli login` puts its token in place whole and owner-only, or not at
// all. The file is made beside the target, readable by its owner alone from
// its first byte, and renamed over the target: a link at the target is
// replaced, never written through, so a file elsewhere keeps its contents;
// many logins at once leave exactly one whole token; a failed write leaves the
// target as it was and nothing of its own behind. The sign-in service is a
// stand-in on a loopback port.

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main as cli } from '../../apps/cli/main.ts';
import { standInGoTrue, type StandIn } from '../support/stand-in-gotrue.ts';

const PASSWORD = 'publish-password-canary-71c0';
let issued = 0;
let gotrue: StandIn;
let folder: string;

beforeAll(async () => {
  gotrue = await standInGoTrue({
    issue: async () => await Promise.resolve(`publish-token-${String((issued += 1))}-canary`),
    expiresIn: 3_600,
  });
  folder = mkdtempSync(join(tmpdir(), 'cli-login-publish-'));
});

afterAll(async () => {
  await gotrue?.close();
  rmSync(folder, { recursive: true, force: true });
});

async function login(tokenFile: string): Promise<number> {
  const quiet = { out: () => {}, err: () => {}, stdin: async () => await Promise.resolve('') };
  return await cli(
    ['login', '--email', 'operator@example.test'],
    {
      OPS_ASTRO_GOTRUE_URL: gotrue.url,
      OPS_ASTRO_PASSWORD: PASSWORD,
      OPS_ASTRO_TOKEN_FILE: tokenFile,
    },
    quiet,
  );
}

const TOKEN = /^publish-token-\d+-canary$/u;

describe('cli login publishes its token whole and owner-only', () => {
  it('replaces a link at the target and leaves the file it pointed to alone', async () => {
    const own = join(folder, 'linked');
    mkdirSync(own);
    const elsewhere = join(folder, 'elsewhere.txt');
    writeFileSync(elsewhere, 'not the token\n', { mode: 0o644 });
    const tokenFile = join(own, 'cli-token');
    symlinkSync(elsewhere, tokenFile);

    expect(await login(tokenFile)).toBe(0);

    expect(readFileSync(elsewhere, 'utf8')).toBe('not the token\n');
    expect(statSync(elsewhere).mode & 0o777).toBe(0o644);
    expect(lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    expect(readFileSync(tokenFile, 'utf8').trim()).toMatch(TOKEN);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it('turns a readable earlier file into an owner-only one holding the new token alone', async () => {
    const own = join(folder, 'earlier');
    mkdirSync(own);
    const tokenFile = join(own, 'cli-token');
    writeFileSync(tokenFile, 'an earlier and much longer token that must not survive\n', {
      mode: 0o644,
    });

    expect(await login(tokenFile)).toBe(0);

    expect(readFileSync(tokenFile, 'utf8')).toMatch(/^publish-token-\d+-canary\n$/u);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
  });
});

describe('cli login publishes its token in one step, or not at all', () => {
  it('many logins at once leave exactly one whole token and nothing else', async () => {
    const own = join(folder, 'many');
    mkdirSync(own);
    const tokenFile = join(own, 'cli-token');

    const codes = await Promise.all(Array.from({ length: 20 }, async () => await login(tokenFile)));

    expect(codes.every((code) => code === 0)).toBe(true);
    expect(readFileSync(tokenFile, 'utf8')).toMatch(/^publish-token-\d+-canary\n$/u);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(own)).toEqual(['cli-token']);
  });

  it('a write that cannot happen leaves the target as it was and nothing of its own', async () => {
    const own = join(folder, 'shut');
    mkdirSync(own);
    const tokenFile = join(own, 'cli-token');
    writeFileSync(tokenFile, 'kept\n', { mode: 0o600 });
    chmodSync(own, 0o500);
    try {
      expect(await login(tokenFile)).not.toBe(0);
    } finally {
      chmodSync(own, 0o700);
    }

    expect(readFileSync(tokenFile, 'utf8')).toBe('kept\n');
    expect(readdirSync(own)).toEqual(['cli-token']);
  });
});
