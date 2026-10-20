// SPDX-License-Identifier: AGPL-3.0-only
//
// The two cases that split preset selection out of #1557, restated from
// #1584: with a bearer saved for the sandbox only, a verb write that selects
// production inline, or names a sign-in address beside a preset, exits 2 and
// sends no request at all.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { run, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-verb-preset-write-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = { OPS_ASTRO_TOKEN_FILE: join(folder, 'token'), OPS_ASTRO_BUSINESS: 'alpha' };
  writeFileSync(join(folder, 'token.sandbox'), 'sandbox-only-bearer\n', { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

it('an inline --env=production beside OPS_ASTRO_ENV=sandbox sends nothing', async () => {
  const refused = await run(['task', 'create', '--title', 'Synthetic task', '--env=production'], {
    ...env,
    OPS_ASTRO_ENV: 'sandbox',
  });
  expect(refused.code).toBe(2);
  expect(seen).toStrictEqual([]);
});

it('--gotrue beside --env sandbox sends nothing', async () => {
  const refused = await run(
    [
      'task',
      'create',
      '--title',
      'Synthetic task',
      '--env',
      'sandbox',
      '--gotrue',
      'https://other.example.test',
    ],
    env,
  );
  expect(refused.code).toBe(2);
  expect(seen).toStrictEqual([]);
});
