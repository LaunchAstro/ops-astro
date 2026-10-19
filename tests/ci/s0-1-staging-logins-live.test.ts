// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-1 staging logins, run for real (STAGING-PREP B3). The command runs
// against a throwaway database whose admin login carries the pooler's
// `<login>.<reference>` form, with the pooler's name sent to loopback
// (`tests/support/pooler-at-loopback.mjs`), so nothing hosted is reached. The
// pooler's own login mapping is not there, so each address is proved by its
// bare login and password. Production's run (`--production`) goes last, by the
// same admin renamed onto production's project, in this file because the logins
// are the server's, shared by every database on it.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import { TEST_ONLY_MARKER } from '../support/marker.ts';

const COMMAND = new URL('../../scripts/ops/staging-logins.mjs', import.meta.url).pathname;
const POOLER_AT_LOOPBACK = new URL('../support/pooler-at-loopback.mjs', import.meta.url).pathname;
/**
 * The one test-only allowance: the throwaway server serves no TLS, so this
 * preload lets the command reach it in plain text on loopback while its admin
 * address still says `sslmode=require` and is judged as on staging.
 */
const PLAINTEXT_AT_LOOPBACK = new URL('../support/plaintext-at-loopback.mjs', import.meta.url)
  .pathname;
const MIGRATIONS = new URL('../../migrations/', import.meta.url).pathname;
const POOLER = 'aws-0-ap-southeast-2.pooler.supabase.com';
const STAGING = Array.from(randomBytes(20), (byte) => String.fromCodePoint(97 + (byte % 26))).join(
  '',
);
const PRODUCTION = Array.from(randomBytes(20), (byte) =>
  String.fromCodePoint(97 + (byte % 26)),
).join('');
const OWN = `own_${randomBytes(4).toString('hex')}`;
const ADMIN = `${OWN}.${STAGING}`;
const PRODUCTION_ADMIN = `${OWN}.${PRODUCTION}`;
const OWN_PASSWORD = `${TEST_ONLY_MARKER}-${randomBytes(18).toString('hex')}`;
const LOGINS = [
  'ops_astro_api',
  'ops_astro_lookup_login',
  'ops_astro_backup_login',
  'ops_astro_forwarder_login',
  'ops_astro_upkeep_login',
  'ops_astro_trace_login',
];

const serverUrl = databaseUrlFromEnvironment();
let db: EmptyDatabase | undefined;
let scratch = '';
let adminUrl = '';

function run(
  step: string,
  folder: string,
  allowance: readonly string[] = [`--import=${PLAINTEXT_AT_LOOPBACK}`],
  production?: { flag: boolean; url: string },
): { status: number; printed: string } {
  const preloads = [`--import=${POOLER_AT_LOOPBACK}`, ...allowance];
  const flag = production?.flag === true ? ['--production'] : [];
  const result = spawnSync(process.execPath, [...preloads, COMMAND, step, ...flag], {
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      STAGING_PROJECT_REF: STAGING,
      ...(production === undefined ? {} : { PRODUCTION_PROJECT_REF: PRODUCTION }),
      DATABASE_ADMIN_URL: production?.url ?? adminUrl,
      OPS_LOGINS_DIR: folder,
    },
  });
  return { status: result.status ?? -1, printed: `${result.stdout}${result.stderr}` };
}

/** The address as the bare login would use it, since loopback has no pooler to map it. */
function bare(address: string): string {
  const url = new URL(address);
  const server = new URL(serverUrl ?? '');
  url.username = decodeURIComponent(url.username).split('.')[0] ?? '';
  url.hostname = server.hostname;
  url.port = server.port;
  // Loopback serves no TLS; the address's own `sslmode=require` is checked apart.
  url.search = '';
  return url.toString();
}

async function asLogin<Row>(address: string, text: string): Promise<readonly Row[]> {
  const login = connectAsAdmin(bare(address), { source: 'harness' });
  try {
    return await login.execute<Row>(text);
  } finally {
    await login.close();
  }
}

const describeLive = serverUrl === undefined ? describe.skip : describe;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  scratch = mkdtempSync(join(tmpdir(), 'staging-logins-'));
  db = await createEmptyDatabase({ part: 'logins' });
  await db.app.close();
  const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
  try {
    // As on the hosted project: the admin is no superuser, it may create roles and
    // hands out BYPASSRLS and REPLICATION only because it holds them, and it owns
    // the database. It holds ADMIN on the app group, as the project's admin does
    // on every role it made.
    await server.execute(
      `create role "${ADMIN}" login nosuperuser createrole bypassrls replication ` +
        `password '${OWN_PASSWORD}'`,
    );
    await server.execute(`alter database "${db.name}" owner to "${ADMIN}"`);
    await server.execute(
      `do $$ begin if exists (select 1 from pg_roles where rolname = 'ops_astro_app') ` +
        `then grant ops_astro_app to "${ADMIN}" with admin option; end if; end $$`,
    );
  } finally {
    await server.close();
  }
  const url = new URL(serverUrl ?? '');
  url.hostname = POOLER;
  url.username = ADMIN;
  url.password = OWN_PASSWORD;
  url.pathname = `/${db.name}`;
  url.search = '?sslmode=require';
  adminUrl = url.toString();
}, 60_000);

afterAll(async () => {
  if (serverUrl === undefined) return;
  rmSync(scratch, { recursive: true, force: true });
  await db?.admin.close();
  await db?.drop();
  const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
  try {
    for (const role of [...LOGINS, ADMIN, PRODUCTION_ADMIN]) {
      // oxlint-disable-next-line no-await-in-loop -- one role at a time
      await server.execute(`drop role if exists "${role}"`);
    }
  } finally {
    await server.close();
  }
});

describeLive('S0-1 staging logins before the reset, run for real', () => {
  it('before the reset: makes the runtime login in the app group and writes its address owner-only', async () => {
    const folder = join(scratch, 'before');
    const { status, printed } = run('before-reset', folder);
    expect(status).toBe(0);
    expect(readdirSync(folder)).toEqual(['DATABASE_URL']);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(folder, 'DATABASE_URL')).mode & 0o777).toBe(0o600);
    const address = readFileSync(join(folder, 'DATABASE_URL'), 'utf8');
    expect(address).toMatch(new RegExp(`^postgresql://ops_astro_api\\.${STAGING}:[^@]+@`, 'u'));
    expect(printed).not.toContain(new URL(address).password);
    expect(printed).not.toContain(OWN_PASSWORD);
    const [row] = await asLogin<{ me: string; app: boolean }>(
      address,
      "select current_user as me, pg_has_role('ops_astro_app', 'usage') as app",
    );
    expect(row).toEqual({ me: 'ops_astro_api', app: true });
  });

  it('without the test-only allowance it will not reach a server in plain text', () => {
    const folder = join(scratch, 'no-allowance');
    const { status, printed } = run('before-reset', folder, []);
    expect(status).toBe(1);
    expect(printed).toContain('staging-logins: stopped while the check');
    expect(existsSync(folder)).toBe(false);
  });

  it('refuses a folder that exists, so an address already given out keeps working', async () => {
    const folder = join(scratch, 'before');
    const address = readFileSync(join(folder, 'DATABASE_URL'), 'utf8');
    const { status, printed } = run('before-reset', folder);
    expect(status).toBe(1);
    expect(printed).toContain('OPS_LOGINS_DIR exists');
    const [row] = await asLogin<{ me: string }>(address, 'select current_user as me');
    expect(row?.me).toBe('ops_astro_api');
  });
});

/** Each after-reset login's setting and its one group. */
const AFTER_RESET = [
  ['DATABASE_LOOKUP_URL', 'ops_astro_lookup'],
  ['BACKUP_SOURCE_URL', 'ops_astro_backup'],
  ['DATABASE_FORWARDER_URL', 'ops_astro_forwarder'],
  ['DATABASE_UPKEEP_URL', 'ops_astro_upkeep'],
  ['DATABASE_TRACE_URL', 'ops_astro_trace'],
] as const;

describeLive('S0-1 staging logins after the reset, run for real', () => {
  it('after the reset: one login per group, each able only to set its role', async () => {
    await migrate(db!.admin, MIGRATIONS);
    // On the project the migrations run as its admin, which then holds ADMIN on each group.
    for (const [, group] of AFTER_RESET) {
      // oxlint-disable-next-line no-await-in-loop -- one group at a time
      await db!.admin.execute(`grant ${group} to "${ADMIN}" with admin option`);
    }
    const folder = join(scratch, 'after');
    const { status, printed } = run('after-reset', folder);
    expect(status).toBe(0);
    expect(readdirSync(folder).toSorted()).toEqual(
      AFTER_RESET.map(([setting]) => setting).toSorted(),
    );
    for (const [setting, group] of AFTER_RESET) {
      const address = readFileSync(join(folder, setting), 'utf8');
      expect(new URL(address).searchParams.get('sslmode')).toBe('require');
      expect(printed).not.toContain(new URL(address).password);
      // oxlint-disable-next-line no-await-in-loop -- one login at a time
      const [row] = await asLogin<{ inherits: boolean; member: boolean; groups: string }>(
        address,
        `select (select m.inherit_option from pg_auth_members m join pg_roles g on g.oid = m.roleid
                  where m.member = r.oid and g.rolname = '${group}') as inherits,
                pg_has_role('${group}', 'member') as member,
                (select string_agg(g.rolname, ',') from pg_auth_members m
                   join pg_roles g on g.oid = m.roleid where m.member = r.oid) as groups
           from pg_roles r where r.rolname = current_user`,
      );
      expect(row).toEqual({ inherits: false, member: true, groups: group });
    }
  }, 120_000);

  it('refuses a login that holds another group since, and changes nothing', async () => {
    await db!.admin.execute('grant ops_astro_backup to ops_astro_lookup_login');
    const folder = join(scratch, 'after-again');
    const { status, printed } = run('after-reset', folder);
    expect(status).toBe(1);
    expect(printed).toContain('ops_astro_lookup_login already holds more than its one group');
    expect(existsSync(folder)).toBe(false);
  });
});

/** The same admin, its login now on production's project, as production's own would be. */
async function onProduction(): Promise<string> {
  const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
  try {
    await server.execute(`alter role "${ADMIN}" rename to "${PRODUCTION_ADMIN}"`);
    await server.execute(`alter role "${PRODUCTION_ADMIN}" password '${OWN_PASSWORD}'`);
  } finally {
    await server.close();
  }
  await db!.admin.execute('revoke ops_astro_backup from ops_astro_lookup_login');
  const url = new URL(adminUrl);
  url.username = PRODUCTION_ADMIN;
  return url.toString();
}

describeLive('production logins, run for real', () => {
  let productionUrl = '';
  beforeAll(async () => {
    productionUrl = await onProduction();
  });

  it("each run refuses the other's project, and makes nothing", () => {
    const refusals = [
      [true, adminUrl, "refused: DATABASE_ADMIN_URL reaches staging's project"],
      [false, productionUrl, "refused: DATABASE_ADMIN_URL reaches production's project"],
    ] as const;
    for (const [flag, url, said] of refusals) {
      const folder = join(scratch, `refused-${String(flag)}`);
      const { status, printed } = run('before-reset', folder, undefined, { flag, url });
      expect([status, printed.includes(said), existsSync(folder)]).toEqual([1, true, false]);
    }
  });

  it("makes the same logins in the same groups, each address on production's project", async () => {
    const [before, after] = [join(scratch, 'prod-before'), join(scratch, 'prod-after')];
    const production = { flag: true, url: productionUrl };
    expect(run('before-reset', before, undefined, production).status).toBe(0);
    const { status, printed } = run('after-reset', after, undefined, production);
    expect(status, printed).toBe(0);
    const made = [
      ['DATABASE_URL', 'ops_astro_app', before],
      ...AFTER_RESET.map(([setting, group]) => [setting, group, after] as const),
    ] as const;
    for (const [setting, group, folder] of made) {
      const address = readFileSync(join(folder, setting), 'utf8');
      const { username, password } = new URL(address);
      expect(decodeURIComponent(username)).toMatch(new RegExp(`\\.${PRODUCTION}$`, 'u'));
      expect(printed).not.toContain(password);
      // oxlint-disable-next-line no-await-in-loop -- one login at a time
      const [row] = await asLogin<{ member: boolean }>(
        address,
        `select pg_has_role('${group}', 'member') as member`,
      );
      expect(row).toEqual({ member: true });
    }
  }, 120_000);
});
