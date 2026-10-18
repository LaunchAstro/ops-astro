// SPDX-License-Identifier: AGPL-3.0-only
//
// The command line can't tell which origin a bearer or delegation in the
// environment was issued for, so under a preset either one is refused, on a
// verb and on an operation: exit 2, the preset and the variable named, the
// value never printed and nothing sent.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, standIn, type Seen } from './preset-stand-in.ts';
import { holds } from './verb-lines.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-preset-hand-set-credential-'));
  const stand = standIn();
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = {
    OPS_ASTRO_TOKEN_FILE: join(folder, 'token'),
    OPS_ASTRO_DELEGATION_FILE: join(folder, 'delegation'),
    OPS_ASTRO_BUSINESS: 'alpha',
  };
  for (const preset of ['sandbox', 'production']) {
    writeFileSync(join(folder, `token.${preset}`), `${preset}-bearer\n`, { mode: 0o600 });
    writeFileSync(join(folder, `delegation.${preset}`), `${preset}-pickup\n`, { mode: 0o600 });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const PATHS = [
  { name: 'a verb', argv: ['task', 'create', '--title', 'Synthetic task', '--agent'] },
  {
    name: 'an operation',
    argv: ['task.create', '--agent', '--json', '{"fields":{"title":"Synthetic task"}}'],
  },
] as const;

describe('a preset refuses a credential set by hand', () => {
  for (const variable of ['OPS_ASTRO_TOKEN', 'OPS_ASTRO_DELEGATION']) {
    for (const preset of ['sandbox', 'production']) {
      for (const path of PATHS) {
        it(`${variable} beside --env ${preset}, on ${path.name}`, async () => {
          const canary = `${variable.toLowerCase()}-hand-set-canary`;
          const refused = await run([...path.argv, '--env', preset], {
            ...env,
            [variable]: canary,
          });
          expect(refused.code).toBe(2);
          expect(refused.err).toContain('--env');
          expect(refused.err).toContain(variable);
          expect(holds(canary, refused.out, refused.err)).toBe(false);
          expect(seen).toStrictEqual([]);
        });
      }
    }
  }
});
