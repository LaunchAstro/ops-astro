// SPDX-License-Identifier: AGPL-3.0-only
//
// Hosted presets (`--env sandbox|production`) keep each one's credentials in
// its own files, so a bearer signed in for one origin is never sent to the
// other's. The app origins and their sign-in services are a stand-in fetch.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCTION, run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-presets-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = {
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
    OPS_ASTRO_PASSWORD: 'preset-password-canary',
    OPS_ASTRO_BUSINESS: 'alpha',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const bearerOf = (one: Seen): string | undefined => one.headers['authorization'];

// eslint-disable-next-line max-lines-per-function -- one journey across both presets, read top to bottom
describe('each hosted preset keeps its own credentials', () => {
  it('a sandbox login is sent only to the sandbox, and production uses its own', async () => {
    const sandbox = await run(['login', '--env', 'sandbox', '--email', 'ada@example.test'], env);
    expect(sandbox.code, sandbox.err).toBe(0);
    const sandboxToken = readFileSync(join(folder, 'token.sandbox'), 'utf8').trim();
    expect(existsSync(join(folder, 'token'))).toBe(false);

    seen.length = 0;
    const listed = await run(['task', 'list', '--env', 'sandbox'], env);
    expect(listed.code, listed.err).toBe(0);
    expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([SANDBOX]);
    expect(bearerOf(seen[0] as Seen)).toBe(`Bearer ${sandboxToken}`);

    seen.length = 0;
    const unsigned = await run(['task', 'list', '--env', 'production'], env);
    expect(unsigned.code).toBe(2);
    expect(seen).toStrictEqual([]);

    const production = await run(
      ['login', '--env', 'production', '--email', 'ada@example.test'],
      env,
    );
    expect(production.code, production.err).toBe(0);
    const productionToken = readFileSync(join(folder, 'token.production'), 'utf8').trim();
    expect(productionToken).not.toBe(sandboxToken);
    expect(readFileSync(join(folder, 'token.sandbox'), 'utf8').trim()).toBe(sandboxToken);

    seen.length = 0;
    const operation = await run(['person.list', '--env', 'production'], env);
    expect(operation.code, operation.err).toBe(0);
    expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([PRODUCTION]);
    expect(bearerOf(seen[0] as Seen)).toBe(`Bearer ${productionToken}`);
  });

  it('logout under one preset leaves the other signed in', async () => {
    const sandbox = await run(['login', '--env', 'sandbox', '--email', 'ada@example.test'], env);
    const production = await run(
      ['login', '--env', 'production', '--email', 'a@example.test'],
      env,
    );
    expect([sandbox.code, production.code]).toStrictEqual([0, 0]);
    expect((await run(['logout', '--env', 'sandbox'], env)).code).toBe(0);
    expect(existsSync(join(folder, 'token.sandbox'))).toBe(false);
    expect(existsSync(join(folder, 'token.production'))).toBe(true);
  });

  it('OPS_ASTRO_ENV picks the preset as --env does', async () => {
    const preset = { ...env, OPS_ASTRO_ENV: 'sandbox' };
    expect((await run(['login', '--email', 'ada@example.test'], preset)).code).toBe(0);
    seen.length = 0;
    expect((await run(['task', 'list'], preset)).code).toBe(0);
    expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([SANDBOX]);
  });

  it('a visual operation under a preset links to that preset’s app', async () => {
    const handed = await run(
      ['review.view', '--env', 'production', '--json', '{"key":"T-7"}'],
      env,
    );
    expect(handed.code, handed.err).toBe(0);
    expect(JSON.parse(handed.out)).toMatchObject({ handoff: `${PRODUCTION}/task/T-7` });
  });
});
