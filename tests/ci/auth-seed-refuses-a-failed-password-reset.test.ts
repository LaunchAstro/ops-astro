// SPDX-License-Identifier: AGPL-3.0-only
//
// A reseed finds each synthetic login already there and resets its password to
// the recorded one. When the identity service refuses that reset, the seed
// fails and writes no credentials, rather than recording a password that cannot
// sign in. The real script runs from a scratch copy of the checkout, against a
// stand-in identity service loaded into its own process: it answers a create
// with "already registered", lists the logins it was asked to create, and
// answers each password reset with the status the case gives.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it, onTestFinished } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const COPIED = [
  'scripts/local/auth-seed.mjs',
  'scripts/local/signing-key.mjs',
  'scripts/local/synthetic-logins.mjs',
  'packages/core-records/src/env-file.ts',
];

/** The stand-in identity service, as a module that replaces the process's fetch. */
const IDENTITY = `const users = [];
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  if (method === 'POST') {
    const { email } = JSON.parse(init.body);
    users.push({ id: crypto.randomUUID(), email });
    return Response.json({ code: 422, msg: 'already registered' }, { status: 422 });
  }
  if (method === 'GET') return Response.json({ users });
  const status = Number(process.env.RESET_STATUS);
  return Response.json(status === 200 ? { id: String(url).split('/').at(-1) } : { msg: 'unavailable' }, { status });
};
`;

/** One reseed in a fresh scratch checkout, its password resets answered with `status`. */
function reseed(status: number) {
  const scratch = mkdtempSync(join(tmpdir(), 'auth-seed-reset-'));
  onTestFinished(() => rmSync(scratch, { recursive: true, force: true }));
  for (const path of COPIED) {
    mkdirSync(dirname(join(scratch, path)), { recursive: true });
    copyFileSync(join(ROOT, path), join(scratch, path));
  }
  mkdirSync(join(scratch, '.local'));
  const key = spawnSync('node', [join(scratch, 'scripts/local/signing-key.mjs')], {
    encoding: 'utf8',
  });
  writeFileSync(join(scratch, '.local/auth-signing-key.json'), key.stdout);
  writeFileSync(join(scratch, 'identity.mjs'), IDENTITY);
  const done = spawnSync(
    'node',
    [
      '--import',
      pathToFileURL(join(scratch, 'identity.mjs')).href,
      join(scratch, 'scripts/local/auth-seed.mjs'),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GOTRUE_URL: 'http://identity.invalid', RESET_STATUS: String(status) },
    },
  );
  const written = existsSync(join(scratch, '.local/synthetic-users.json'));
  return { status: done.status, out: done.stdout + done.stderr, written };
}

it('a reseed whose password resets succeed records the five logins', () => {
  const { status, out, written } = reseed(200);
  expect({ status, written, exists: out.match(/ exists /gu)?.length }).toEqual({
    status: 0,
    written: true,
    exists: 5,
  });
});

it('a reseed whose password reset is refused fails and writes no credentials', () => {
  const { status, out, written } = reseed(503);
  expect({ status, written }).toEqual({ status: 1, written: false });
  expect(out).toContain('503');
  expect(out).not.toContain('slice-local-');
});
