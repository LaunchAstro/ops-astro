// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

it('the server entry publishes its configured hosted sign-in key at runtime', async () => {
  const db = await createFreshDatabase({ part: 'solow003signin' });
  const url = databaseUrlFromEnvironment();
  if (url === undefined) throw new Error('Sol proof needs its throwaway Postgres');
  const admin = new URL(url);
  admin.pathname = `/${db.name}`;
  const issuer = 'https://sol-proof.supabase.co/auth/v1';
  const key = 'sb_publishable_sol_ow003_public_fixture';
  const child = spawn(process.execPath, ['apps/api/server.ts'], {
    env: {
      PATH: process.env['PATH'],
      NODE_DISABLE_COMPILE_CACHE: '1',
      API_PORT: '0',
      DATABASE_URL: db.appUrl,
      DATABASE_ADMIN_URL: admin.toString(),
      GOTRUE_URL: issuer,
      SUPABASE_PUBLISHABLE_KEY: key,
      RECOVERY_BUSINESS_KEYS: 'none',
      DELEGATION_CREDENTIAL_KEY_ID: 'sol@1',
      DELEGATION_CREDENTIAL_KEYS: `sol@1:${randomBytes(32).toString('base64url')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', () => {});
  try {
    let port: string | undefined;
    for (let n = 0; n < 100; n += 1) {
      port = /listening on http:\/\/127\.0\.0\.1:(\d+)/u.exec(output)?.[1];
      if (port !== undefined || child.exitCode !== null) break;
      // eslint-disable-next-line no-await-in-loop -- readiness is observed before the next poll.
      await setTimeout(50);
    }
    expect(port, 'the real server started against its own migrated database').toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}/api/sign-in`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ issuer, key });
  } finally {
    child.kill('SIGTERM');
    await exited;
    await db.drop();
  }
});
