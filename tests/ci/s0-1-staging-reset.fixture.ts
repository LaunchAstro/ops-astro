// SPDX-License-Identifier: AGPL-3.0-only
//
// The staging reset suite's fixtures (s0-1-staging-reset.test.ts): the real
// command as a person runs it, a throwaway database whose two logins carry the
// pooler's `<login>.<reference>` form, and the provider's admin API as a
// stand-in on loopback, so nothing hosted is reached.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';
import { serveTestKeySetApart, type ServedKeySet } from '../support/sign-in.ts';

const RESET = new URL('../../scripts/ops/staging-reset.mjs', import.meta.url).pathname;
export const MIGRATIONS: string = new URL('../../migrations/', import.meta.url).pathname;

const ref = (): string =>
  Array.from(randomBytes(20), (byte) => String.fromCodePoint(97 + (byte % 26))).join('');
export const STAGING: string = ref();
export const PRODUCTION: string = ref();
export const OTHER: string = ref();
export const KEY: string = `${TEST_ONLY_MARKER}-${randomBytes(16).toString('hex')}`;
export const OWN_PASSWORD: string = `${TEST_ONLY_MARKER}-${randomBytes(18).toString('hex')}`;
export const RUN_PASSWORD: string = `${TEST_ONLY_MARKER}-${randomBytes(18).toString('hex')}`;

export const serverUrl: string | undefined = databaseUrlFromEnvironment();
/** Made by the hooks, so a file with no database makes no folder. */
export let scratch = '';

// ---- the provider's admin API, on loopback ----------------------------------

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly key: boolean;
  readonly body: Record<string, unknown> | undefined;
}
export const calls: Call[] = [];
export const users: Map<string, string> = new Map();
let auth: Server;
let authUrl = '';

function serveAuth(): Promise<void> {
  auth = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk: Buffer) => (text += chunk.toString()));
    request.on('end', () => {
      const body = text === '' ? undefined : (JSON.parse(text) as Record<string, unknown>);
      const path = (request.url ?? '').split('?')[0] ?? '';
      const key = request.headers['apikey'] === KEY;
      calls.push({ method: request.method ?? '', path, key, body });
      const reply = (status: number, value: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (!key) return reply(401, { msg: 'no key' });
      if (request.method === 'POST' && path === '/admin/users') {
        const email = String(body?.['email']);
        if (users.has(email)) return reply(422, { msg: 'already registered' });
        users.set(email, randomUUID());
        return reply(200, { id: users.get(email), email });
      }
      if (request.method === 'GET' && path === '/admin/users')
        return reply(200, { users: [...users].map(([email, id]) => ({ id, email })) });
      if (request.method === 'PUT' && path.startsWith('/admin/users/')) return reply(200, {});
      return reply(404, {});
    });
  });
  return new Promise((resolve) => {
    auth.listen(0, '127.0.0.1', () => {
      const address = auth.address();
      authUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
}

// ---- the command, as a person runs it ---------------------------------------

export interface Run {
  readonly status: number | null;
  readonly out: string;
}

export function run(env: Record<string, string>, args: readonly string[] = []): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RESET, ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (status) => resolve({ status, out }));
  });
}

/** Nothing the command prints carries a password, the key or a project reference. */
export function quiet(result: Run): void {
  for (const secret of [OWN_PASSWORD, RUN_PASSWORD, KEY, STAGING, PRODUCTION, OTHER])
    expect(result.out).not.toContain(secret);
}

export let db: EmptyDatabase | undefined;
export let own = '';
export let runner = '';
export const login = (role: string): string => `${db?.name ?? ''}_${role}.${STAGING}`;

export function databaseUrl(user: string, password: string, host?: string): string {
  const url = new URL(serverUrl ?? 'postgres://localhost/x');
  url.pathname = `/${db?.name ?? ''}`;
  url.username = user;
  url.password = password;
  if (host !== undefined) url.hostname = host;
  return url.toString();
}

export let seedDirs = 0;
export function settings(overrides: Record<string, string> = {}): Record<string, string> {
  seedDirs += 1;
  return {
    STAGING_PROJECT_REF: STAGING,
    PRODUCTION_PROJECT_REF: PRODUCTION,
    DATABASE_ADMIN_URL: own,
    DATABASE_URL: runner,
    GOTRUE_URL: authUrl,
    SUPABASE_SERVICE_KEY: KEY,
    OPS_SEED_DIR: join(scratch, `seed-${seedDirs}`),
    OPS_ASTRO_DEPLOYMENTS: join(scratch, `records-${seedDirs}`),
    ...overrides,
  };
}

/** A table no reset would keep: still there means nothing was emptied. */
export const canaryHolds = async (): Promise<boolean> =>
  await onDatabase(async (admin) => {
    const rows = await admin.execute<{ held: boolean }>(
      `select to_regclass('public.reset_canary') is not null as held`,
    );
    return rows[0]?.held === true;
  });

export async function onDatabase<T>(
  work: (admin: ReturnType<typeof connectAsAdmin>) => Promise<T>,
): Promise<T> {
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${db?.name ?? ''}`;
  const admin = connectAsAdmin(url.toString(), { source: 'harness' });
  try {
    return await work(admin);
  } finally {
    await admin.close();
  }
}

export const plantCanary = async (): Promise<void> =>
  await onDatabase(async (admin) => {
    await admin.execute('create table if not exists public.reset_canary (x text)');
  });

export let keySet: ServedKeySet | undefined;

/** The throwaway database, its two project logins and the stand-ins, for the whole file. */
export function stagingResetHooks(): void {
  if (serverUrl === undefined) return;
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'staging-reset-'));
    await serveAuth();
    keySet = await serveTestKeySetApart();
    db = await createEmptyDatabase({ part: 'reset' });
    await db.app.close();
    await db.admin.close();
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    try {
      // The pooler's `<login>.<reference>` form: the owner stands for the
      // project's migration login, the runner for its runtime login.
      await server.execute(
        `create role "${login('own')}" login superuser password '${OWN_PASSWORD}'`,
      );
      await server.execute(
        `create role "${login('run')}" login nosuperuser nocreatedb nocreaterole nobypassrls ` +
          `inherit password '${RUN_PASSWORD}' in role ops_astro_app`,
      );
      await server.execute(`grant connect on database "${db.name}" to "${login('run')}"`);
      // As on the project, the migration login owns the database.
      await server.execute(`alter database "${db.name}" owner to "${login('own')}"`);
    } finally {
      await server.close();
    }
    own = databaseUrl(login('own'), OWN_PASSWORD);
    runner = databaseUrl(login('run'), RUN_PASSWORD);
    await plantCanary();
  }, 60_000);

  afterAll(async () => {
    rmSync(scratch, { recursive: true, force: true });
    await keySet?.close();
    await new Promise((resolve) => {
      auth.close(resolve);
    });
    await db?.drop();
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    try {
      for (const role of ['own', 'run'])
        // oxlint-disable-next-line no-await-in-loop
        await server.execute(`drop role if exists "${login(role)}"`);
    } finally {
      await server.close();
    }
  });
}

/** A refusal before any connection: named, quiet, and nothing written or asked. */
export const refusedBeforeConnecting = async (
  env: Record<string, string>,
  names: string,
  args: readonly string[] = [],
): Promise<void> => {
  const before = calls.length;
  const result = await run(env, args);
  expect(result.status).toBe(1);
  expect(result.out).toContain(names);
  expect(result.out).toContain('Nothing was done');
  quiet(result);
  expect(calls.length).toBe(before);
  expect(existsSync(env['OPS_SEED_DIR'] ?? '')).toBe(false);
  expect(existsSync(env['OPS_ASTRO_DEPLOYMENTS'] ?? ''), 'a refusal records nothing').toBe(false);
  expect(await canaryHolds()).toBe(true);
};

/** Each run is recorded (ORCH40's reset-gate ruling): one line, no setting's value in it. */
export function recordedOnce(env: Record<string, string>): void {
  const record = readFileSync(
    join(env['OPS_ASTRO_DEPLOYMENTS'] ?? '', 'deployments.jsonl'),
    'utf8',
  );
  const lines = record.trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ action: 'staging reset' });
  for (const [name, value] of Object.entries(env))
    if (name !== 'OPS_ASTRO_DEPLOYMENTS') expect(lines[0], name).not.toContain(value);
}
