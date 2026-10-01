// SPDX-License-Identifier: AGPL-3.0-only
// Uncommitted first-read proofs for the frozen S0-6 release increment.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { outputDigest } from '../../scripts/ops/release.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 's0-6-review-proof-'));
const dist = join(scratch, 'dist');
const out = join(scratch, 'output');
let logs = '';
const canary = 'review-canary-9c4e';
const settings = {
  VITE_GOTRUE_URL: `https://${canary}-gotrue.invalid`,
  VITE_API_ORIGIN: `https://${canary}-api.invalid`,
  VITE_OPS_ASTRO_BUILD: `${canary}-build`,
  VITE_REVIEW_SECRET_KEY: `${canary}-vite-generic`,
  API_ORIGIN: `https://${canary}-proxy.invalid`,
  DATABASE_URL: `postgres://${canary}-db.invalid/db`,
  DATABASE_ADMIN_URL: `postgres://${canary}-admin.invalid/db`,
  GOTRUE_URL: `https://${canary}-issuer.invalid`,
  SERVED_HOST: `${canary}-host.invalid`,
  SUPABASE_KEY_SET_URL: `https://${canary}-jwks.invalid`,
  SUPABASE_JWT_SECRET: `${canary}-legacy-signing`,
  DELEGATION_CREDENTIAL_KEY_ID: `${canary}-key-id`,
  DELEGATION_CREDENTIAL_KEYS: `${canary}-keyring`,
  OPS_RELEASE: `${canary}-release`,
  REVIEW_SECRET_KEY: `${canary}-generic`,
};

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function containsAny(bytes: Buffer, probes: string[]): boolean {
  return probes.some((probe) => bytes.includes(Buffer.from(probe)));
}

function run(args: string[], environment: Record<string, string>) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...environment },
  });
}

beforeAll(() => {
  const build = run(
    [
      'node_modules/vite/bin/vite.js',
      'build',
      '--config',
      'apps/web/vite.config.ts',
      '--outDir',
      dist,
    ],
    settings,
  );
  logs += `${build.stdout}${build.stderr}`;
  expect(build.status, build.stderr).toBe(0);
  mkdirSync(join(dist, 'api'));
  writeFileSync(join(dist, 'api/health'), 'static collision');
  const release = run(['scripts/ops/release.ts', '--dist', dist, '--out', out], settings);
  logs += `${release.stdout}${release.stderr}`;
  expect(release.status, release.stderr).toBe(0);
}, 120_000);

it('proves build settings never reach static, function, metadata, maps or logs', () => {
  const hits: string[] = [];
  const files = filesUnder(out).map((path) => ({ path, bytes: readFileSync(path) }));
  for (const [name, value] of Object.entries(settings)) {
    const probes = [
      value,
      Buffer.from(value).toString('base64'),
      Buffer.from(value).toString('hex'),
      encodeURIComponent(value),
      value.replaceAll('/', '\\/'),
    ];
    for (const { path, bytes } of files) {
      if (containsAny(bytes, probes)) hits.push(`${name}: ${path}`);
    }
    if (containsAny(Buffer.from(logs), probes)) hits.push(`${name}: build or release log`);
  }
  expect(hits).toStrictEqual([]);
});

it('proves a changed root build.json invalidates the stamped digest', () => {
  const changed = join(scratch, 'changed');
  cpSync(out, changed, { recursive: true });
  const original = JSON.parse(readFileSync(join(changed, 'build.json'), 'utf8')) as {
    build: string;
    digest: string;
  };
  writeFileSync(join(changed, 'build.json'), JSON.stringify({ ...original, build: 'tampered' }));
  expect(outputDigest(changed)).not.toBe(original.digest);
});

it('proves an added output file invalidates the stamped digest', () => {
  const changed = join(scratch, 'added');
  cpSync(out, changed, { recursive: true });
  const original = JSON.parse(readFileSync(join(changed, 'build.json'), 'utf8')) as {
    digest: string;
  };
  writeFileSync(join(changed, 'extra.txt'), 'added after stamping');
  expect(outputDigest(changed)).not.toBe(original.digest);
});

it('proves /api cannot be shadowed by a static file', () => {
  expect(readFileSync(join(out, 'static/api/health'), 'utf8')).toBe('static collision');
  const config = JSON.parse(readFileSync(join(out, 'config.json'), 'utf8')) as {
    routes: { dest?: string; handle?: string }[];
  };
  const api = config.routes.findIndex((route) => route.dest === '/api');
  const filesystem = config.routes.findIndex((route) => route.handle === 'filesystem');
  expect(api).toBeGreaterThanOrEqual(0);
  expect(api).toBeLessThan(filesystem);
});

it('proves the bundled API serves without a database admin login', () => {
  const entry = join(out, 'functions/api.func/index.mjs');
  const script = `const m = await import(${JSON.stringify(entry)}); try {
    const r = await m.GET(new Request('https://ops.example.test/api/health',
      { headers: { host: 'ops.example.test' } }));
    console.log('status ' + r.status);
  } catch (error) { console.log('threw ' + error.message); }`;
  const processResult = run(['--input-type=module', '-e', script], {
    DATABASE_URL: 'postgres://app:x@127.0.0.1:1/none',
    GOTRUE_URL: 'http://127.0.0.1:54391',
    SERVED_HOST: 'ops.example.test',
    DELEGATION_CREDENTIAL_KEY_ID: 'test/release@1',
    DELEGATION_CREDENTIAL_KEYS: `test/release@1:${'k'.repeat(43)}`,
  });
  expect(processResult.stdout.trim()).toBe('status 503');
});
