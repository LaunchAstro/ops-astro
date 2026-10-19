// SPDX-License-Identifier: AGPL-3.0-only
//
// Without a preset, each setting is read in the order `docs/local/CLI.md`
// gives ("Manual mode"), on a verb and on an operation: the bearer from
// `OPS_ASTRO_TOKEN`, then its file; the delegation from `OPS_ASTRO_DELEGATION`,
// then its file; the API from `--api`, then `OPS_ASTRO_API_URL`, then
// `http://127.0.0.1:8790`. The preset files beside them are never read.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { PRODUCTION, run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';
import { holds } from './verb-lines.ts';

const PRESET_CANARIES = [
  'sandbox-bearer-canary',
  'production-bearer-canary',
  'sandbox-pickup-canary',
  'production-pickup-canary',
];

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-manual-precedence-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  const files: Readonly<Record<string, string>> = {
    token: 'plain-file-bearer',
    delegation: 'plain-file-pickup',
    'token.sandbox': 'sandbox-bearer-canary',
    'token.production': 'production-bearer-canary',
    'delegation.sandbox': 'sandbox-pickup-canary',
    'delegation.production': 'production-pickup-canary',
  };
  for (const [name, value] of Object.entries(files)) {
    writeFileSync(join(folder, name), `${value}\n`, { mode: 0o600 });
  }
  env = {
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
    OPS_ASTRO_BUSINESS: 'alpha',
    OPS_ASTRO_AGENT: '1',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const PATHS = [
  { name: 'a verb', argv: ['task', 'get', 'T-1'] },
  { name: 'an operation', argv: ['task.read', '--json', '{"recordId":"T-1"}'] },
] as const;

const ROWS = [
  {
    name: 'both credentials from the environment, the API from --api',
    argv: ['--api', SANDBOX],
    env: {
      OPS_ASTRO_TOKEN: 'env-bearer',
      OPS_ASTRO_DELEGATION: 'env-pickup',
      OPS_ASTRO_API_URL: PRODUCTION,
    },
    origin: SANDBOX,
    bearer: 'env-bearer',
    delegation: 'env-pickup',
  },
  {
    name: 'both from their files, the API from OPS_ASTRO_API_URL',
    argv: [],
    env: { OPS_ASTRO_API_URL: PRODUCTION },
    origin: PRODUCTION,
    bearer: 'plain-file-bearer',
    delegation: 'plain-file-pickup',
  },
  {
    name: 'the bearer from the environment, the delegation from its file, the default API',
    argv: [],
    env: { OPS_ASTRO_TOKEN: 'env-bearer' },
    origin: 'http://127.0.0.1:8790',
    bearer: 'env-bearer',
    delegation: 'plain-file-pickup',
  },
] as const;

describe('manual mode follows its documented order', () => {
  PATHS.flatMap((path) => ROWS.map((row) => ({ path, row }))).forEach(({ path, row }) => {
    it(`${path.name}: ${row.name}`, async () => {
      await run([...path.argv, ...row.argv], { ...env, ...row.env });
      expect(seen.length).toBe(1);
      const [sent] = seen as [Seen];
      expect(new URL(sent.url).origin).toBe(row.origin);
      expect(sent.headers['authorization']).toBe(`Bearer ${row.bearer}`);
      expect(sent.headers[DELEGATION_HEADER]).toBe(row.delegation);
      for (const canary of PRESET_CANARIES) {
        expect(holds(canary, JSON.stringify(seen)), 'a preset file was read').toBe(false);
      }
    });
  });
});
