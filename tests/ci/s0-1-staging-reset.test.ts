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

import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requireOperatingOperator } from '../../scripts/ops/operator.ts';
import { STAGING_CAST, notInvented } from '../../scripts/ops/staging-reset.ts';
import { signBearer, TEST_ISSUER } from '../support/sign-in.ts';
import {
  calls,
  canaryHolds,
  databaseUrl,
  db,
  keySet,
  login,
  MIGRATIONS,
  onDatabase,
  OTHER,
  own,
  OWN_PASSWORD,
  plantCanary,
  PRODUCTION,
  quiet,
  refusedBeforeConnecting,
  run,
  RUN_PASSWORD,
  runner,
  scratch,
  seedDirs,
  serverUrl,
  settings,
  STAGING,
  stagingResetHooks,
  users,
} from './s0-1-staging-reset.fixture.ts';

const AUTH_SEED = new URL('../../scripts/local/auth-seed.mjs', import.meta.url).pathname;
/** The named test, S0-1 staging reset refuses production, case by case, in order. */
const live = it.skipIf(serverUrl === undefined);
const NAME = 'S0-1 staging reset refuses production';

/** The same login and password, the pooler's form naming another project. */
const elsewhere = (role: string, password: string): string =>
  databaseUrl(`${db?.name ?? ''}_${role}.${OTHER}`, password);

stagingResetHooks();

live(
  `${NAME}: refuses a database or sign-in address of another project, by setting name`,
  async () => {
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
    // No host, a list of hosts, a host named again in the query, a login no decoder reads.
    for (const address of [
      own.replace(/@[^/]+\//u, '@/'),
      own.replace(/@([^/]+)\//u, `@db.${OTHER}.supabase.co,$1/`),
    ])
      // oxlint-disable-next-line no-await-in-loop -- one refusal at a time, each checked
      await refusedBeforeConnecting(
        settings({ DATABASE_ADMIN_URL: address }),
        'DATABASE_ADMIN_URL',
      );
    await refusedBeforeConnecting(
      settings({ DATABASE_ADMIN_URL: `${own}?host=db.${OTHER}.supabase.co` }),
      'DATABASE_ADMIN_URL',
    );
    await refusedBeforeConnecting(
      settings({ DATABASE_URL: databaseUrl(`%zz.${STAGING}`, RUN_PASSWORD) }),
      'DATABASE_URL',
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
  },
);

live(`${NAME}: refuses production's project, named as staging's or reached`, async () => {
  await refusedBeforeConnecting(
    settings({ PRODUCTION_PROJECT_REF: STAGING }),
    'STAGING_PROJECT_REF',
  );
  const reaching = databaseUrl(`${db?.name ?? ''}_own.${PRODUCTION}`, OWN_PASSWORD);
  await refusedBeforeConnecting(
    settings({ DATABASE_ADMIN_URL: reaching }),
    "DATABASE_ADMIN_URL reaches production's project",
  );
  await refusedBeforeConnecting(
    settings({ GOTRUE_URL: `https://${PRODUCTION}.supabase.co/auth/v1` }),
    "GOTRUE_URL reaches production's project",
  );
});

live(`${NAME}: refuses a production backup, or any file, as its input`, async () => {
  const dump = join(scratch, 'production.dump');
  await refusedBeforeConnecting(settings(), 'a backup is never its input', [dump]);
  await refusedBeforeConnecting(settings(), 'a backup is never its input', ['--from', dump]);
});

live(
  `${NAME}: empties, migrates and seeds invented people, their sign-ins sent no mail`,
  async () => {
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
  },
  180_000,
);

live(
  `${NAME}: admits the made-up operator at staging's own gate, and no one else (G1)`,
  async () => {
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
  },
  60_000,
);

live(
  `${NAME}: runs again on staging: what staging held is emptied, the passwords made fresh`,
  async () => {
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
  },
  180_000,
);

live(
  `${NAME}: refuses a database neither marked made-up nor new, emptying nothing`,
  async () => {
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
  },
  60_000,
);

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
