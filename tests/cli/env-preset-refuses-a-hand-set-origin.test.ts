// SPDX-License-Identifier: AGPL-3.0-only
//
// A hosted preset names the origin; a hand-set address beside it is refused
// before anything is read or sent, and the refusal names both. Each selector
// alone reaches its preset, so the refusals are not a preset that never works.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-preset-conflict-'));
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

const SELECTORS = [
  { name: '--env', argv: ['--env', 'sandbox'], env: {} },
  { name: 'OPS_ASTRO_ENV', argv: [], env: { OPS_ASTRO_ENV: 'sandbox' } },
] as const;

const HAND_SET = [
  { name: '--api', argv: ['--api', 'https://elsewhere.example.test'], env: {} },
  { name: '--gotrue', argv: ['--gotrue', 'https://elsewhere.example.test'], env: {} },
  { name: '--web', argv: ['--web', 'https://elsewhere.example.test'], env: {} },
  { name: 'OPS_ASTRO_API_URL', argv: [], env: { OPS_ASTRO_API_URL: 'https://e.example.test' } },
  {
    name: 'OPS_ASTRO_GOTRUE_URL',
    argv: [],
    env: { OPS_ASTRO_GOTRUE_URL: 'https://e.example.test' },
  },
  { name: 'OPS_ASTRO_WEB_URL', argv: [], env: { OPS_ASTRO_WEB_URL: 'https://e.example.test' } },
  { name: 'SUPABASE_PUBLISHABLE_KEY', argv: [], env: { SUPABASE_PUBLISHABLE_KEY: 'sb_x' } },
] as const;

describe('a preset beside a hand-set origin is refused', () => {
  SELECTORS.forEach((selector) => {
    it(`${selector.name} alone sends the operation to the sandbox`, async () => {
      const answered = await run(['person.list', ...selector.argv], { ...env, ...selector.env });
      expect(answered.code, answered.err).toBe(0);
      expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([SANDBOX]);
    });

    HAND_SET.forEach((setting) => {
      it(`${selector.name} with ${setting.name}: exit 2, both named, nothing sent`, async () => {
        const refused = await run(['person.list', ...selector.argv, ...setting.argv], {
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

  it('the verb form refuses the same way', async () => {
    const refused = await run(['task', 'list', '--env', 'sandbox', '--api', 'https://e.test'], env);
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--api');
    expect(seen).toStrictEqual([]);
  });

  it('an empty --env is refused, not read as no preset', async () => {
    const refused = await run(['person.list', '--env='], {
      ...env,
      OPS_ASTRO_API_URL: 'https://e.example.test',
    });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--env');
    expect(seen).toStrictEqual([]);
  });

  ['staging', 'constructor', 'toString'].forEach((name) => {
    it(`an unknown preset (${name}) is refused and the two presets are named`, async () => {
      const refused = await run(['person.list', '--env', name], env);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('sandbox');
      expect(refused.err).toContain('production');
      expect(seen).toStrictEqual([]);
    });
  });
});
