// SPDX-License-Identifier: AGPL-3.0-only
//
// The migrations refuse to run while another session is connected, and the
// session pooler keeps a login's connection open, idle, after its client has
// gone, the reset's own login's too. Asked only once emptied, that refusal
// left staging empty. The reset asks before it empties, by the same rule, so
// a connected session leaves the database as it was.

import { expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import {
  canaryHolds,
  own,
  quiet,
  run,
  runner,
  serverUrl,
  settings,
  stagingResetHooks,
} from './s0-1-staging-reset.fixture.ts';

stagingResetHooks();

it.skipIf(serverUrl === undefined).each([
  ['a session of the runtime login', () => runner],
  ['an idle session of its own login', () => own],
])(
  'staging reset refuses before emptying while %s is connected',
  async (_session, address) => {
    const held = connectAsAdmin(address(), { source: 'harness' });
    try {
      await held.execute('select 1');
      const result = await run(settings());

      expect(result.status).toBe(1);
      expect(result.out).toContain('1 other session is connected');
      expect(result.out).toContain('nothing was emptied');
      quiet(result);
      expect(await canaryHolds()).toBe(true);
    } finally {
      await held.close();
    }
  },
  180_000,
);
