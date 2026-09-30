// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 staging reset refuses production (re-plan section 3, S0-1's made-up
// data line; STAGING-PREP B4). Staging's reset (empty, migrate, seed) refuses,
// by setting name and before it connects, any database or sign-in address whose
// Supabase project reference is not staging's, or is production's, and any file
// (a backup is never its input); connected, a database neither marked made-up
// nor new. A refusal writes nothing and prints no address, password, key or
// reference. On staging's own database it empties, migrates and seeds invented
// people only, makes their sign-ins through the provider's admin API with no
// mail sent, and seeds the made-up operator staging's own gate admits (G1).
//
// The real command runs against a throwaway database here. Its logins carry
// the pooler's `<login>.<reference>` form, and the provider's admin API is a
// stand-in on loopback: nothing hosted is reached.

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { STAGING_CAST, notInvented } from '../../scripts/ops/staging-reset.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  serveTestKeySetApart,
  signBearer,
  TEST_ISSUER,
  type ServedKeySet,
} from '../support/sign-in.ts';

const RESET = new URL('../../scripts/ops/staging-reset.mjs', import.meta.url).pathname;
const AUTH_SEED = new URL('../../scripts/local/auth-seed.mjs', import.meta.url).pathname;
const MIGRATIONS = new URL('../../migrations/', import.meta.url).pathname;

const ref = (): string =>
  Array.from(randomBytes(20), (byte) => String.fromCodePoint(97 + (byte % 26))).join('');
const STAGING = ref();
const PRODUCTION = ref();
const OTHER = ref();
const KEY = `service-${randomBytes(16).toString('hex')}`;
const OWN_PASSWORD = randomBytes(18).toString('hex');
const RUN_PASSWORD = randomBytes(18).toString('hex');

const serverUrl = databaseUrlFromEnvironment();
const scratch = mkdtempSync(join(tmpdir(), 'staging-reset-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// ---- the provider's admin API, on loopback ----------------------------------

interface Call {
  readonly method: string;
  readonly path: string;
  readonly key: boolean;
  readonly body: Record<string, unknown> | undefined;
}
const calls: Call[] = [];
const users = new Map<string, string>();
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
  return new Promise((resolve) =>
    auth.listen(0, '127.0.0.1', () => {
      const address = auth.address();
      authUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    }),
  );
}

// ---- the command, as a person runs it ---------------------------------------

interface Run {
  readonly status: number | null;
  readonly out: string;
}

function run(env: Record<string, string>, args: readonly string[] = []): Promise<Run> {
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
function quiet(result: Run): void {
  for (const secret of [OWN_PASSWORD, RUN_PASSWORD, KEY, STAGING, PRODUCTION, OTHER])
    expect(result.out).not.toContain(secret);
}

let db: EmptyDatabase | undefined;
let own = '';
let runner = '';
const login = (role: string): string => `${db?.name ?? ''}_${role}.${STAGING}`;

function databaseUrl(user: string, password: string, host?: string): string {
  const url = new URL(serverUrl ?? 'postgres://localhost/x');
  url.pathname = `/${db?.name ?? ''}`;
  url.username = user;
  url.password = password;
  if (host !== undefined) url.hostname = host;
  return url.toString();
}

let seedDirs = 0;
function settings(overrides: Record<string, string> = {}): Record<string, string> {
  seedDirs += 1;
  return {
    STAGING_PROJECT_REF: STAGING,
    PRODUCTION_PROJECT_REF: PRODUCTION,
    DATABASE_ADMIN_URL: own,
    DATABASE_URL: runner,
    GOTRUE_URL: authUrl,
    SUPABASE_SERVICE_KEY: KEY,
    OPS_SEED_DIR: join(scratch, `seed-${seedDirs}`),
    ...overrides,
  };
}

/** A table no reset would keep: still there means nothing was emptied. */
const canaryHolds = async (): Promise<boolean> =>
  await onDatabase(async (admin) => {
    const rows = await admin.execute<{ held: boolean }>(
      `select to_regclass('public.reset_canary') is not null as held`,
    );
    return rows[0]?.held === true;
  });

async function onDatabase<T>(
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

const plantCanary = async (): Promise<void> =>
  await onDatabase(async (admin) => {
    await admin.execute('create table if not exists public.reset_canary (x text)');
  });

let keySet: ServedKeySet | undefined;

describe.skipIf(serverUrl === undefined)('S0-1 staging reset refuses production', () => {
  beforeAll(async () => {
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
    } finally {
      await server.close();
    }
    own = databaseUrl(login('own'), OWN_PASSWORD);
    runner = databaseUrl(login('run'), RUN_PASSWORD);
    await plantCanary();
  }, 60_000);

  afterAll(async () => {
    await keySet?.close();
    await new Promise((resolve) => auth.close(resolve));
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

  const refusedBeforeConnecting = async (
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
    expect(await canaryHolds()).toBe(true);
  };

  it('refuses a database or sign-in address of another project, by setting name', async () => {
    const elsewhere = (role: string, password: string): string =>
      databaseUrl(`${db?.name ?? ''}_${role}.${OTHER}`, password);
    await refusedBeforeConnecting(
      settings({ DATABASE_ADMIN_URL: elsewhere('own', OWN_PASSWORD) }),
      'DATABASE_ADMIN_URL',
    );
    await refusedBeforeConnecting(
      settings({ DATABASE_URL: elsewhere('run', RUN_PASSWORD) }),
      'DATABASE_URL',
    );
    // Another project's direct address, and a Supabase address the reset does not know.
    await refusedBeforeConnecting(
      settings({
        DATABASE_ADMIN_URL: databaseUrl('postgres', OWN_PASSWORD, `db.${OTHER}.supabase.co`),
      }),
      'DATABASE_ADMIN_URL',
    );
    await refusedBeforeConnecting(
      settings({
        DATABASE_ADMIN_URL: databaseUrl(login('own'), OWN_PASSWORD, `${STAGING}.supabase.co`),
      }),
      'DATABASE_ADMIN_URL',
    );
    await refusedBeforeConnecting(
      settings({ GOTRUE_URL: `https://${OTHER}.supabase.co/auth/v1` }),
      'GOTRUE_URL',
    );
    await refusedBeforeConnecting(
      settings({ STAGING_PROJECT_REF: 'Not-A-Ref' }),
      'STAGING_PROJECT_REF',
    );
    await refusedBeforeConnecting(settings({ SUPABASE_SERVICE_KEY: '' }), 'SUPABASE_SERVICE_KEY');
  });

  it("refuses production's project, named as staging's or reached", async () => {
    await refusedBeforeConnecting(
      settings({ PRODUCTION_PROJECT_REF: STAGING }),
      'STAGING_PROJECT_REF',
    );
    const reaching = databaseUrl(`${db?.name ?? ''}_own.${PRODUCTION}`, OWN_PASSWORD);
    await refusedBeforeConnecting(settings({ DATABASE_ADMIN_URL: reaching }), 'DATABASE_ADMIN_URL');
    await refusedBeforeConnecting(
      settings({ GOTRUE_URL: `https://${PRODUCTION}.supabase.co/auth/v1` }),
      'GOTRUE_URL',
    );
  });

  it('refuses a production backup, or any file, as its input', async () => {
    const dump = join(scratch, 'production.dump');
    await refusedBeforeConnecting(settings(), 'a backup is never its input', [dump]);
    await refusedBeforeConnecting(settings(), 'a backup is never its input', ['--from', dump]);
  });

  it('empties, migrates and seeds invented people, their sign-ins sent no mail', async () => {
    const env = settings();
    const result = await run(env);
    expect(result.status, result.out).toBe(0);
    quiet(result);
    expect(await canaryHolds()).toBe(false);

    const migrations = readdirSync(MIGRATIONS).filter((file) => file.endsWith('.sql')).length;
    const seen = await onDatabase(async (admin) => ({
      applied: await admin.execute<{ n: number }>(
        'select count(*)::int as n from ops.schema_migrations',
      ),
      mark: await admin.execute<{ mark: string | null }>(
        `select shobj_description(oid, 'pg_database') as mark from pg_database
          where datname = current_database()`,
      ),
      people: await admin.execute<{ name: string }>(
        'select display_name as name from public.people order by 1',
      ),
    }));
    expect(seen.applied[0]?.n).toBe(migrations);
    expect(seen.mark[0]?.mark).toMatch(/^ops-astro made-up data; businesses: /u);
    const cast = new Set(STAGING_CAST.map((member) => member.person));
    expect(seen.people.length).toBeGreaterThan(0);
    for (const { name } of seen.people) expect(cast.has(name) || name === 'Ext Alpha').toBe(true);

    // The admin API alone, with the key, each address made up and confirmed, so no mail goes.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.key).toBe(true);
      expect(call.path).toMatch(/^\/admin\/users(?:\/[0-9a-f-]{36})?$/u);
      if (call.method === 'POST') {
        expect(String(call.body?.['email'])).toMatch(/@(?:alpha|bravo)\.local$/u);
        expect(call.body?.['email_confirm']).toBe(true);
      }
    }
    for (const member of STAGING_CAST) expect(users.has(member.email)).toBe(true);

    // The passwords go to the owner's folder alone, made fresh, never the local ones.
    const folder = env['OPS_SEED_DIR'] ?? '';
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const file = join(folder, 'synthetic-users.json');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { password: string }[];
    for (const { password } of written) {
      expect(password).not.toMatch(/^slice-local-/u);
      expect(result.out).not.toContain(password);
    }
  }, 180_000);

  it("admits the made-up operator at staging's own gate, and no one else (G1)", async () => {
    const records = mkdtempSync(join(scratch, 'records-'));
    const gate = async (email: string): Promise<boolean> => {
      const subject = users.get(email) ?? '';
      const bearer = await signBearer({
        sub: subject,
        aud: 'authenticated',
        iss: TEST_ISSUER,
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
      });
      const answer = await requireOperatingOperator({
        OPS_ASTRO_TOKEN: bearer,
        OPS_ASTRO_BUSINESS: 'alpha',
        OPS_ASTRO_DEPLOYMENTS: records,
        DATABASE_URL: runner,
        DATABASE_ADMIN_URL: own,
        GOTRUE_URL: TEST_ISSUER,
        SUPABASE_KEY_SET_URL: keySet?.url ?? '',
      });
      return answer.ok;
    };
    const operator = STAGING_CAST.find((member) => member.grants?.length === 1);
    expect(operator?.grants).toEqual([['operations', 'manage']]);
    expect(await gate(operator?.email ?? '')).toBe(true);
    expect(await gate('ada@alpha.local')).toBe(false);
    expect(await gate('bea@bravo.local')).toBe(false);
  }, 60_000);

  it('runs again on staging: what staging held is emptied, the passwords made fresh', async () => {
    await plantCanary();
    const first = JSON.parse(
      readFileSync(join(scratch, `seed-${seedDirs}`, 'synthetic-users.json'), 'utf8'),
    ) as { email: string; password: string }[];
    const env = settings();
    const result = await run(env);
    expect(result.status, result.out).toBe(0);
    quiet(result);
    expect(await canaryHolds()).toBe(false);
    const again = JSON.parse(
      readFileSync(join(env['OPS_SEED_DIR'] ?? '', 'synthetic-users.json'), 'utf8'),
    ) as { email: string; password: string }[];
    for (const member of again)
      expect(first.find((earlier) => earlier.email === member.email)?.password).not.toBe(
        member.password,
      );
  }, 180_000);

  it('refuses a database neither marked made-up nor new, emptying nothing', async () => {
    await onDatabase(async (admin) => {
      await admin.execute(`comment on database "${db?.name ?? ''}" is null`);
    });
    await plantCanary();
    const before = calls.length;
    const env = settings();
    const result = await run(env);
    expect(result.status).toBe(1);
    expect(result.out).toContain('neither marked made-up nor new');
    quiet(result);
    expect(calls.length).toBe(before);
    expect(await canaryHolds()).toBe(true);
  }, 60_000);
});

describe('S0-1 staging reset, invented names only', () => {
  it("staging's cast carries invented names and made-up addresses only", () => {
    expect(notInvented(STAGING_CAST)).toEqual([]);
  });

  it('refuses a real-looking name in the cast', () => {
    const planted = STAGING_CAST.map((member) =>
      member.email === 'ada@alpha.local' ? { ...member, person: 'Ada Lovelace' } : member,
    );
    expect(notInvented(planted)).toEqual(['Ada Lovelace']);
    const outside = [{ ...STAGING_CAST[0]!, email: 'ada@example.com' }];
    expect(notInvented(outside)).toEqual([outside[0]!.person]);
  });

  it("the local sign-in seed gives Ada a made-up surname, not a real person's", () => {
    const source = readFileSync(AUTH_SEED, 'utf8');
    expect(source).toMatch(/email: 'ada@alpha\.local',[^}]*person: 'Ada Alpha'/u);
  });
});
