// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { refusalBeforeConnecting } from '../../scripts/ops/staging-reset.ts';
import {
  OWN_PASSWORD,
  PRODUCTION,
  serverUrl,
  settings,
  stagingResetHooks,
} from '../ci/s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined)(
  'an encoded startup user cannot route staging reset to production',
  async () => {
    const role = `sol_ow067_production.${PRODUCTION}`;
    const server = connectAsAdmin(serverUrl ?? '', { source: 'harness' });
    await server.execute(`create role "${role}" login superuser password '${OWN_PASSWORD}'`);
    try {
      const env = settings();
      const advertised = new URL(env['DATABASE_ADMIN_URL'] ?? '');
      advertised.hostname = '127.0.0.1';
      const overridden = `${advertised.toString()}?%75ser=${encodeURIComponent(role)}`;
      const database = connectAsAdmin(overridden, { source: 'harness' });
      try {
        const [row] = await database.execute<{ actual: string }>('select current_user as actual');
        expect(row?.actual, 'postgres.js forwards the decoded query user in its startup packet').toBe(role);
      } finally {
        await database.close();
      }
      // Restore the public pooler hostname that the reset judges. The real
      // pooler selects its project using the startup user, as the driver sent above.
      env['DATABASE_ADMIN_URL'] = `${env['DATABASE_ADMIN_URL']}?%75ser=${encodeURIComponent(role)}`;
      const refused = refusalBeforeConnecting(env, []);
      expect(refused ?? 'accepted', 'production is the actual startup user').toMatch(/DATABASE_ADMIN_URL/u);
    } finally {
      await server.execute(`drop role "${role}"`);
      await server.close();
    }
  },
  60_000,
);
