// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { reachesDatabase, withSuite } from './db-conformance-report-fixture.ts';

it.skipIf((process.env['DATABASE_URL'] ?? '') === '')(
  'skipped test diagnostics withhold credentials and private paths',
  async () => {
    await withSuite(
      reachesDatabase +
        `
test.skip('private-diagnostic-marker password=' + process.env.DB_REPORT_TEST_TOKEN + ' /private/example/credentials.env', () => {});
`,
      (run) => {
        expect(run.status).toBe(1);
        expect(run.stderr).toContain('database test(s) were skipped');
        expect(run.stderr).toContain('private-diagnostic-marker');
        expect
          .soft(
            String(run.stderr).includes('synthetic-env-credential-5159'),
            'credential disclosed',
          )
          .toBe(false);
        expect
          .soft(
            String(run.stderr).includes('/private/example/credentials.env'),
            'private path disclosed',
          )
          .toBe(false);
      },
    );
  },
  120_000,
);
