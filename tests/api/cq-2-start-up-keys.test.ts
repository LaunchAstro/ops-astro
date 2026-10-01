// SPDX-License-Identifier: AGPL-3.0-only
//
// CQ-2: the keys kept out of the process environment, and out of what start-up
// prints when it stops. The fault text kept out of logs is in `cq-2.test.ts`.

import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ISSUER } from './fixture.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/runtime-config.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const ROOT = join(import.meta.dirname, '../..');
const NAMES = JSON.stringify(['GATE_SIGNING_', 'DELEGATION_CREDENTIAL_KEY']);
const DEAD = 'postgres://cq2@127.0.0.1:1/cq2';
const URLS = ['DATABASE_URL', 'DATABASE_ADMIN_URL'].map((name) => process.env[name] ?? DEAD);

/** `node apps/api/server.ts`, printing the key settings it holds once listening, or at exit. */
function start(settings: Record<string, string>, [url, admin]: readonly string[] = [DEAD, DEAD]) {
  const report = `const held = () => console.error('CQ2-ENV', JSON.stringify(Object.keys(process.env)
    .filter((name) => ${NAMES}.some((prefix) => name.startsWith(prefix)))));
  process.on('exit', held); const log = console.log; console.log = (...parts) => { log(...parts);
    if (String(parts[0]).startsWith('api: listening')) setImmediate(() => process.exit(0)); };`;
  const preload = `data:text/javascript,${encodeURIComponent(report)}`;
  const env = { PATH: process.env['PATH'], DATABASE_URL: url, DATABASE_ADMIN_URL: admin };
  const settled = { ...env, GOTRUE_URL: ISSUER, API_PORT: '0' };
  const options = { cwd: ROOT, env: { ...settled, ...settings }, timeout: 60_000 };
  const run = spawnSync(process.execPath, ['--import', preload, 'apps/api/server.ts'], options);
  return { status: run.status, output: `${run.stdout}${run.stderr}` };
}

describe('CQ-2 start-up', () => {
  it('CQ-2 malformed keyring: start-up stops naming the setting, never a key byte', () => {
    const bytes = randomBytes(16).toString('base64url');
    const keyring = { DELEGATION_CREDENTIAL_KEYS: `cq2@1:${bytes}` };
    const { status, output } = start({ DELEGATION_CREDENTIAL_KEY_ID: 'cq2@1', ...keyring });
    expect(status).toBe(1);
    expect(output).toContain('api: delegation credential keys: DELEGATION_CREDENTIAL_KEYS');
    expect(output).not.toContain(bytes);
  });
});

describe.skipIf(databaseUrlFromEnvironment() === undefined)('CQ-2 process environment', () => {
  it('CQ-2 process.env: after start-up it holds no key the server put there', () => {
    const gate = join(ROOT, '.local', 'gate.env');
    const wrote = !existsSync(gate);
    mkdirSync(join(ROOT, '.local'), { recursive: true });
    if (wrote)
      writeFileSync(gate, `GATE_SIGNING_KEY_ID=cq2@1\nGATE_SIGNING_SECRET=${randomUUID()}`);
    expect(runtimeKeys({}).delegation.ok).toBe(true);
    // The keys are in the checkout's files only; the server recovers, listens, then reports.
    const { status, output } = start({ RECOVERY_BUSINESS_KEYS: 'none' }, URLS);
    if (wrote) rmSync(gate);
    expect([status, output]).toStrictEqual([
      0,
      expect.stringMatching(/listening[^]*CQ2-ENV \[\]/u),
    ]);
  });
});
