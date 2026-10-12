// SPDX-License-Identifier: AGPL-3.0-only
/* oxlint-disable no-await-in-loop, no-promise-executor-return -- the proof bodies are kept as written */
// Run from the repository root: node tests/support/password-change-gotrue-proof.mjs
// Runs the password change's GoTrue proof against the committed HEAD, in its own throwaway
// Postgres, GoTrue and runner containers, removed at the end.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSigningKeys } from '../../scripts/local/signing-key.mjs';

const suffix = randomUUID().slice(0, 8);
const network = `password-proof-${suffix}-net`;
const pg = `password-proof-${suffix}-pg`;
const auth = `password-proof-${suffix}-auth`;
const runner = `password-proof-${suffix}-runner`;
const folder = mkdtempSync(join(tmpdir(), 'password-proof-'));
const proofs = [
  'tests/review/password-change-confirming-sign-in-ends-at-gotrue-proof.test.ts',
  'tests/web/password-update-refuses-redirects.test.ts',
];
const docker = (...args) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const pgImage = 'postgres@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24';
const authImage =
  'public.ecr.aws/supabase/gotrue:v2.192.0@sha256:b252efb680be37d4a8bf77c210cf0439c19b63a4b51929233a65dd101d25bdab';

async function ready(check) {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      if (check()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Own proof container did not become ready.');
}

try {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`Proof head: ${head}`);
  const archive = execFileSync('git', ['archive', head], { maxBuffer: 128 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', folder], { input: archive });

  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    pg,
    '--network',
    network,
    '-e',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    pgImage,
  );
  await ready(
    () => spawnSync('docker', ['exec', pg, 'pg_isready', '-q', '-U', 'postgres']).status === 0,
  );
  docker('exec', pg, 'psql', '-U', 'postgres', '-c', 'create database proof_auth');
  docker('exec', pg, 'psql', '-U', 'postgres', '-d', 'proof_auth', '-c', 'create schema auth');
  const issuer = `http://${auth}:9999`;
  const settings = {
    GOTRUE_API_HOST: '0.0.0.0',
    PORT: '9999',
    API_EXTERNAL_URL: issuer,
    GOTRUE_SITE_URL: 'http://localhost:5190',
    GOTRUE_DB_DRIVER: 'postgres',
    GOTRUE_DB_NAMESPACE: 'auth',
    DATABASE_URL: `postgres://postgres@${pg}:5432/proof_auth?sslmode=disable&search_path=auth`,
    GOTRUE_JWT_KEYS: JSON.stringify(await generateSigningKeys()),
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
  const envFile = join(folder, 'proof-auth.env');
  writeFileSync(
    envFile,
    Object.entries(settings)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    { mode: 0o600 },
  );
  docker('run', '-d', '--name', auth, '--network', network, '--env-file', envFile, authImage);
  await ready(
    () =>
      docker(
        'exec',
        pg,
        'psql',
        '-U',
        'postgres',
        '-d',
        'proof_auth',
        '-Atc',
        'select count(*) from auth.schema_migrations',
      ) !== '0',
  );
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--name',
      runner,
      '--network',
      network,
      '-v',
      `${folder}:/review`,
      '-w',
      '/review',
      '-e',
      `PASSWORD_PROOF_GOTRUE_URL=${issuer}`,
      'node:24-bookworm',
      'sh',
      '-c',
      `npm install -g pnpm@12.3.4 >/tmp/install.log 2>&1 && pnpm install --ignore-scripts >>/tmp/install.log 2>&1 && node node_modules/vitest/vitest.mjs run ${proofs.join(' ')}`,
    ],
    { stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  for (const name of [runner, auth, pg])
    spawnSync('docker', ['rm', '-fv', name], { stdio: 'ignore' });
  spawnSync('docker', ['network', 'rm', network], { stdio: 'ignore' });
  rmSync(folder, { recursive: true, force: true });
}
