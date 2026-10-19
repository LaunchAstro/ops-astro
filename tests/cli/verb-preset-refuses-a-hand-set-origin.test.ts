// SPDX-License-Identifier: AGPL-3.0-only
//
// On a verb, a preset beside a hand-set address is refused before anything is
// read or sent, naming both: each address flag spaced and inline, and each
// address variable, against each way of naming the preset. Each selector
// alone reaches the sandbox, so the refusals are not a preset that never works.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-verb-preset-conflict-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = { OPS_ASTRO_TOKEN_FILE: join(folder, 'token'), OPS_ASTRO_BUSINESS: 'alpha' };
  writeFileSync(join(folder, 'token.sandbox'), 'sandbox-bearer\n', { mode: 0o600 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const LINE = ['task', 'create', '--title', 'Synthetic task'];
const ELSEWHERE = 'https://elsewhere.example.test';

const SELECTORS = [
  { name: '--env', shown: '--env sandbox', argv: ['--env', 'sandbox'], env: {} },
  { name: '--env', shown: '--env=sandbox', argv: ['--env=sandbox'], env: {} },
  { name: 'OPS_ASTRO_ENV', shown: 'OPS_ASTRO_ENV', argv: [], env: { OPS_ASTRO_ENV: 'sandbox' } },
] as const;

const HAND_SET = [
  ...['api', 'gotrue', 'web'].flatMap((flag) => [
    { name: `--${flag}`, shown: `--${flag} <url>`, argv: [`--${flag}`, ELSEWHERE], env: {} },
    { name: `--${flag}`, shown: `--${flag}=<url>`, argv: [`--${flag}=${ELSEWHERE}`], env: {} },
  ]),
  ...['OPS_ASTRO_API_URL', 'OPS_ASTRO_GOTRUE_URL', 'OPS_ASTRO_WEB_URL'].map((name) => ({
    name,
    shown: name,
    argv: [],
    env: { [name]: ELSEWHERE },
  })),
  {
    name: 'SUPABASE_PUBLISHABLE_KEY',
    shown: 'SUPABASE_PUBLISHABLE_KEY',
    argv: [],
    env: { SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_elsewhere' },
  },
];

describe('a verb under a preset refuses a hand-set address', () => {
  SELECTORS.forEach((selector) => {
    it(`${selector.shown} alone sends the write to the sandbox`, async () => {
      const answered = await run([...LINE, ...selector.argv], { ...env, ...selector.env });
      expect(answered.code, answered.err).toBe(0);
      expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([SANDBOX]);
    });

    HAND_SET.forEach((setting) => {
      it(`${selector.shown} with ${setting.shown}: exit 2, both named, nothing sent`, async () => {
        const refused = await run([...LINE, ...selector.argv, ...setting.argv], {
          ...env,
          ...selector.env,
          ...setting.env,
        });
        expect(refused.code).toBe(2);
        expect(refused.err).toContain(selector.name);
        expect(refused.err).toContain(setting.name);
        expect(seen).toStrictEqual([]);
      });
    });
  });
});
