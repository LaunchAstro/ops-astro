// SPDX-License-Identifier: AGPL-3.0-only
// Run from the repository root: node tests/api/c40-password-set-provider-containers.mjs
// Owns and removes only its throwaway containers, volume, network and keys.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { generateSigningKeys } from '../../scripts/local/signing-key.mjs';

const pgImage = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const authImage =
  'public.ecr.aws/supabase/gotrue:v2.192.0@sha256:b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab';
const suffix = randomUUID().slice(0, 8);
const pg = `c40-reset-${suffix}-pg`;
const auth = `c40-reset-${suffix}-auth`;
const network = `c40-reset-${suffix}-net`;
const directory = mkdtempSync('/tmp/c40-reset-proof-');
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function sparePort() {
  const server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

async function ready(check) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- each readiness check follows the preceding wait
      if (await check()) return;
    } catch {}
    // oxlint-disable-next-line no-await-in-loop -- readiness polling is sequential
    await setTimeout(250);
  }
  throw new Error('proof container did not become ready');
}

try {
  console.log(
    `Proof head: ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}`,
  );
  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    pg,
    '--network',
    network,
    '-p',
    '127.0.0.1::5432',
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    pgImage,
  );
  const pgPort = docker('port', pg, '5432').split(':').at(-1);
  const databaseUrl = `postgres://postgres@127.0.0.1:${pgPort}/postgres`;
  await ready(
    () =>
      spawnSync('docker', ['exec', pg, 'pg_isready', '-q', '-h', '127.0.0.1', '-U', 'postgres'])
        .status === 0,
  );
  docker(
    'exec',
    pg,
    'psql',
    '-U',
    'postgres',
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'create database sol_auth',
  );
  docker(
    'exec',
    pg,
    'psql',
    '-U',
    'postgres',
    '-d',
    'sol_auth',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'create schema auth',
  );
  const port = await sparePort();
  const issuer = `http://127.0.0.1:${port}`;
  const keys = await generateSigningKeys();
  const keysPath = join(directory, 'auth-keys.json');
  writeFileSync(keysPath, JSON.stringify(keys), { mode: 0o600 });
  const settings = {
    GOTRUE_API_HOST: '0.0.0.0',
    PORT: '9999',
    API_EXTERNAL_URL: issuer,
    GOTRUE_SITE_URL: 'http://127.0.0.1:5190',
    GOTRUE_DB_DRIVER: 'postgres',
    GOTRUE_DB_NAMESPACE: 'auth',
    DATABASE_URL: `postgres://postgres@${pg}:5432/sol_auth?sslmode=disable&search_path=auth`,
    GOTRUE_JWT_KEYS: JSON.stringify(keys),
    GOTRUE_JWT_SECRET: randomBytes(32).toString('hex'),
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_ISSUER: issuer,
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_JWT_ADMIN_ROLES: 'service_role',
    GOTRUE_JWT_EXP: '3600',
    GOTRUE_DISABLE_SIGNUP: 'false',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true',
    GOTRUE_MAILER_AUTOCONFIRM_ENABLED: 'true',
    GOTRUE_SMTP_HOST: '',
    GOTRUE_MFA_MAX_VERIFIED_FACTORS: '1',
    GOTRUE_LOG_LEVEL: 'error',
  };
  const args = ['run', '-d', '--name', auth, '--network', network, '-p', `127.0.0.1:${port}:9999`];
  for (const [key, value] of Object.entries(settings)) args.push('-e', `${key}=${value}`);
  args.push(authImage);
  docker(...args);
  await ready(async () => (await fetch(`${issuer}/health`)).ok);
  const result = spawnSync(
    'corepack',
    [
      'pnpm',
      'exec',
      'vitest',
      'run',
      'tests/api/c40-password-set-revocation.test.ts',
      'tests/api/c40-password-set-provider.test.ts',
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DATABASE_ADMIN_URL: databaseUrl,
        C40_AUTH_URL: issuer,
        SOL_AUTH_KEYS: keysPath,
        SOL_AUTH_DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/sol_auth`,
      },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  for (const name of [auth, pg]) {
    spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
  }
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(directory, { recursive: true, force: true });
}
