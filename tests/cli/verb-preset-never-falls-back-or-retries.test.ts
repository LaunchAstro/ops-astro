// SPDX-License-Identifier: AGPL-3.0-only
//
// Under a preset the bearer comes from that preset's file and nowhere else.
// Missing, or only the plain file or the other preset's: exit 2, `no bearer`
// naming `login --env <preset>`, and no request. A stale bearer is sent once,
// to its own origin, and the refusal is final: exit 1, no second request.
// The same on a verb and on an operation.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, SANDBOX, standIn, type Seen } from './preset-stand-in.ts';

let folder: string;
let seen: Seen[];
let env: Record<string, string>;

const stale = (url: URL): Response | undefined =>
  url.origin === SANDBOX && url.pathname.startsWith('/api/b/')
    ? Response.json({ refused: true, code: 'AUTH_INVALID', names: [], fixes: [] }, { status: 401 })
    : undefined;

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'cli-preset-no-fallback-'));
  const stand = standIn(stale);
  seen = stand.seen;
  vi.stubGlobal('fetch', stand.fetch);
  env = { OPS_ASTRO_TOKEN_FILE: join(folder, 'token'), OPS_ASTRO_BUSINESS: 'alpha' };
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(folder, { recursive: true, force: true });
});

const save = (name: string, value: string): void => {
  writeFileSync(join(folder, name), `${value}\n`, { mode: 0o600 });
};

const PATHS = [
  { name: 'a verb', argv: ['task', 'get', 'T-1', '--env', 'sandbox'] },
  { name: 'an operation', argv: ['task.read', '--env', 'sandbox', '--json', '{"recordId":"T-1"}'] },
] as const;

const MISSING = [
  { name: 'no file at all', files: [] },
  { name: 'only the plain file', files: ['token'] },
  { name: 'only the other preset’s file', files: ['token.production'] },
  { name: 'the plain and the other preset’s files', files: ['token', 'token.production'] },
] as const;

describe('a preset never falls back to another bearer, or retries', () => {
  for (const path of PATHS) {
    for (const missing of MISSING) {
      it(`${path.name} with ${missing.name}: exit 2, no bearer, nothing sent`, async () => {
        for (const file of missing.files) save(file, `${file}-bearer`);
        const refused = await run(path.argv, env);
        expect(refused.code).toBe(2);
        expect(refused.err).toContain('no bearer');
        expect(refused.err).toContain('login --env sandbox');
        expect(seen).toStrictEqual([]);
      });
    }

    it(`${path.name} with a stale bearer: one request to its own origin, then exit 1`, async () => {
      for (const file of ['token', 'token.sandbox', 'token.production']) save(file, `${file}-x`);
      const refused = await run(path.argv, env);
      expect(refused.code).toBe(1);
      expect(seen.map((one) => new URL(one.url).origin)).toStrictEqual([SANDBOX]);
      expect(seen[0]?.headers['authorization']).toBe('Bearer token.sandbox-x');
    });
  }
});
