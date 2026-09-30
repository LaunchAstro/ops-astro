// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { createFunctionHandler } from '../../apps/api/function.ts';
import { buildOutputProblems } from '../../scripts/ops/build-output.ts';

const scratch = mkdtempSync(join(tmpdir(), 'sl01-s06-review-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const host = 'ops.example.test';
const keyId = 'test/review@1';

function handler() {
  return createFunctionHandler({
    SERVED_HOST: host,
    DATABASE_URL: 'postgres://app:unused@127.0.0.1:1/none',
    DATABASE_ADMIN_URL: 'postgres://app:unused@127.0.0.1:1/none',
    GOTRUE_URL: 'https://issuer.example.test/auth/v1',
    DELEGATION_CREDENTIAL_KEY_ID: keyId,
    DELEGATION_CREDENTIAL_KEYS: `${keyId}:${randomBytes(32).toString('base64url')}`,
  });
}

it('S0-6 function refuses absolute-form foreign authority before a database read', async () => {
  const handle = handler();
  const response = await handle(
    new Request('https://foreign.example.test/api/health', { headers: { host } }),
  );
  expect(response.status).toBe(421);
});

it('S0-6 no edge caching marks the bare /api, HEAD and OPTIONS answers no-store', async () => {
  const handle = handler();
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const response = await handle(
      new Request(`https://${host}/api`, { method, headers: { host } }),
    );
    expect(response.headers.get('cache-control'), method).toBe('private, no-store');
  }
});

function output(name: string, routes: unknown = []): string {
  const root = join(scratch, name);
  const func = join(root, 'functions/api/index.func');
  mkdirSync(func, { recursive: true });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ version: 3, routes }));
  writeFileSync(
    join(func, '.vc-config.json'),
    JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', regions: ['syd1'] }),
  );
  writeFileSync(join(func, 'index.mjs'), 'export {};');
  return root;
}

it('S0-6 functions in Sydney refuses a symlink inside a function bundle', () => {
  const root = output('symlink');
  const executable = join(root, 'functions/api/index.func/index.mjs');
  rmSync(executable);
  const outside = join(scratch, 'outside.mjs');
  writeFileSync(outside, 'export {};');
  symlinkSync(outside, executable);
  expect(buildOutputProblems(root)).not.toStrictEqual([]);
});

it('S0-6 functions in Sydney refuses a function config symlink outside the output', () => {
  const root = output('config-symlink');
  const config = join(root, 'functions/api/index.func/.vc-config.json');
  const outside = join(scratch, 'outside-config.json');
  writeFileSync(outside, '{"runtime":"nodejs22.x","handler":"index.mjs","regions":["syd1"]}');
  rmSync(config);
  symlinkSync(outside, config);
  expect(buildOutputProblems(root)).not.toStrictEqual([]);
});

it('S0-6 functions in Sydney refuses malformed routes', () => {
  const root = output('malformed-routes', { middlewarePath: '_middleware' });
  expect(buildOutputProblems(root)).not.toStrictEqual([]);
});
