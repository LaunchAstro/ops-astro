// SPDX-License-Identifier: AGPL-3.0-only
//
// A verb line's connection flags are refused in `main`'s own terms: a flag
// given no value or an empty one, a name that is not a preset (`constructor`
// included), and a misspelt flag such as `--envv`, which would otherwise be
// dropped and leave the line running under `OPS_ASTRO_ENV`. Each one resolves
// with exit 2, names what it refused and sends nothing; none rejects.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-verb-flag-refusal-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = { OPS_ASTRO_TOKEN_FILE: join(folder, 'token'), OPS_ASTRO_BUSINESS: 'alpha' };
  for (const name of ['token', 'token.sandbox', 'token.production']) {
    writeFileSync(join(folder, name), `${name}-bearer\n`, { mode: 0o600 });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const CONNECTION = ['api', 'gotrue', 'web', 'env', 'business'] as const;

const CASES = [
  ...CONNECTION.flatMap((flag) => [
    { name: `--${flag} with no value`, argv: ['task', 'list', `--${flag}`], env: {}, names: flag },
    {
      name: `--${flag}= empty, before a verb flag`,
      argv: ['task', 'list', `--${flag}=`, '--detail', 'brief'],
      env: {},
      names: flag,
    },
    { name: `--${flag}= empty, last`, argv: ['task', 'list', `--${flag}=`], env: {}, names: flag },
  ]),
  ...['staging', 'constructor', 'toString'].flatMap((name) => [
    { name: `--env ${name}`, argv: ['task', 'list', '--env', name], env: {}, names: 'sandbox' },
    { name: `--env=${name}`, argv: ['task', 'list', `--env=${name}`], env: {}, names: 'sandbox' },
    {
      name: `OPS_ASTRO_ENV=${name}`,
      argv: ['task', 'list'],
      env: { OPS_ASTRO_ENV: name },
      names: 'sandbox',
    },
  ]),
  {
    name: '--envv production beside OPS_ASTRO_ENV=sandbox',
    argv: ['task', 'create', '--title', 'Synthetic task', '--envv', 'production'],
    env: { OPS_ASTRO_ENV: 'sandbox' },
    names: '--envv',
  },
  {
    name: '--envv=production',
    argv: ['task', 'list', '--envv=production'],
    env: {},
    names: '--envv',
  },
];

describe('a verb line refuses a bad connection flag with exit 2', () => {
  CASES.forEach((one) => {
    it(`${one.name}: resolves 2, names it, sends nothing`, async () => {
      const refused = await run(one.argv, { ...env, ...one.env });
      expect(refused.code).toBe(2);
      expect(refused.err).toContain(one.names);
      expect(seen).toStrictEqual([]);
    });
  });
});
