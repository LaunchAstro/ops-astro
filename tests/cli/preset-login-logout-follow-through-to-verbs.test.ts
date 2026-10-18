// SPDX-License-Identifier: AGPL-3.0-only
//
// `login --env P` and `logout --env P` carry through to the verbs, for each
// preset, with files under the default names and under custom ones. The
// issued token goes to P only, and the other preset has no bearer; a pickup
// credential saved for P goes to P only; logout removes P's bearer and
// delegation, and leaves the other preset's files byte for byte.
//
// The default names are used in a folder of the test's own: the checkout's
// `.local/` may hold a real sign-in, which a test must never overwrite or remove.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { PRODUCTION, run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';
import { holds } from './verb-lines.ts';

const ORIGIN: Readonly<Record<string, string>> = { sandbox: SANDBOX, production: PRODUCTION };

let folder: string;
let seen: Seen[];

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-preset-follow-through-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const NAMES = [
  { name: 'default-named files', token: '.local/cli-token', delegation: '.local/cli-delegation' },
  { name: 'custom files', token: 'my-bearer', delegation: 'my-pickup' },
] as const;

const READ = ['task', 'get', 'T-1'];
const WRITE = ['task', 'create', '--title', 'Synthetic task'];

describe.each(['sandbox', 'production'])('under %s', (preset) => {
  const other = preset === 'sandbox' ? 'production' : 'sandbox';

  it.each(NAMES)('$name: login, the verbs and logout keep to the preset', async (names) => {
    const token = join(folder, names.token);
    const delegation = join(folder, names.delegation);
    const env = {
      OPS_ASTRO_TOKEN_FILE: token,
      OPS_ASTRO_DELEGATION_FILE: delegation,
      OPS_ASTRO_PASSWORD: 'follow-through-password',
      OPS_ASTRO_BUSINESS: 'alpha',
    };
    const signedIn = await run(['login', '--env', preset, '--email', 'ada@example.test'], env);
    expect(signedIn.code).toBe(0);
    expect([
      existsSync(`${token}.${preset}`),
      existsSync(token),
      existsSync(`${token}.${other}`),
    ]).toStrictEqual([true, false, false]);
    const issued = readFileSync(`${token}.${preset}`, 'utf8').trim();

    for (const line of [READ, WRITE]) {
      seen.length = 0;
      // eslint-disable-next-line no-await-in-loop -- one verb at a time
      const sent = await run([...line, '--env', preset], env);
      expect(sent.code, line.join(' ')).toBe(0);
      expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([ORIGIN[preset]]);
      expect(seen[0]?.headers['authorization'] === `Bearer ${issued}`).toBe(true);
      seen.length = 0;
      // eslint-disable-next-line no-await-in-loop -- one verb at a time
      const elsewhere = await run([...line, '--env', other], env);
      expect(elsewhere.code, line.join(' ')).toBe(2);
      expect(elsewhere.err).toContain('no bearer');
      expect(seen).toStrictEqual([]);
    }

    const pickup = `${preset}-pickup-canary`;
    writeFileSync(`${delegation}.${preset}`, `${pickup}\n`, { mode: 0o600 });
    writeFileSync(`${token}.${other}`, `${other}-bearer-canary\n`, { mode: 0o600 });
    writeFileSync(`${delegation}.${other}`, `${other}-pickup-canary\n`, { mode: 0o600 });
    const kept = [readFileSync(`${token}.${other}`), readFileSync(`${delegation}.${other}`)];

    seen.length = 0;
    const agent = await run([...READ, '--env', preset, '--agent'], env);
    expect(agent.code).toBe(0);
    expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([ORIGIN[preset]]);
    expect(seen[0]?.headers[DELEGATION_HEADER] === pickup).toBe(true);
    expect(holds(`${other}-bearer-canary`, JSON.stringify(seen))).toBe(false);
    expect(holds(`${other}-pickup-canary`, JSON.stringify(seen))).toBe(false);

    expect((await run(['logout', '--env', preset], env)).code).toBe(0);
    expect([existsSync(`${token}.${preset}`), existsSync(`${delegation}.${preset}`)]).toStrictEqual(
      [false, false],
    );
    for (const line of [READ, WRITE]) {
      seen.length = 0;
      // eslint-disable-next-line no-await-in-loop -- one verb at a time
      const after = await run([...line, '--env', preset], env);
      expect(after.code, line.join(' ')).toBe(2);
      expect(seen).toStrictEqual([]);
    }
    const now = [readFileSync(`${token}.${other}`), readFileSync(`${delegation}.${other}`)];
    expect(now.map((bytes, at) => bytes.equals(kept[at] as Buffer))).toStrictEqual([true, true]);
  });
});
