// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import { CARRY_ENDED_SESSIONS } from '../../scripts/ops/staging-reset.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';

it('the carried reset proof copies revocations before its competing write', async () => {
  const db = await createFreshDatabase({ part: 'sol_fix3_precondition' });
  const revoker = connect(db.appUrl);
  const session = randomUUID();
  try {
    await revoker.withBusiness(randomUUID(), (tx) => endProviderSession(tx, session));
    await db.admin.transaction(async (execute) => {
      // This is the same preparation immediately before the competing write
      // in staging-reset-keeps-session-ended-during-reset-proof.test.ts.
      for (const statement of CARRY_ENDED_SESSIONS) await execute(statement);
      const copied = await execute(
        'select session_id from ops_astro_reset.ended_provider_sessions where session_id = $1',
        [session],
      );
      expect(copied, 'the claimed after-copy schedule must actually have copied the positive control').toHaveLength(1);
    });
  } finally {
    await revoker.close();
    await db.drop();
  }
});

it('the actual reset copy blocks a concurrent session ending', async () => {
  const db = await createFreshDatabase({ part: 'sol_fix3_copy_lock' });
  const revoker = connect(db.appUrl);
  const earlier = randomUUID();
  try {
    await revoker.withBusiness(randomUUID(), (tx) => endProviderSession(tx, earlier));
    await db.admin.transaction(async (execute) => {
      for (const statement of CARRY_ENDED_SESSIONS) await execute(statement);
      await execute('select ops_astro_reset.carry_ended_sessions()');
      expect(await execute(
        'select session_id from ops_astro_reset.ended_provider_sessions where session_id = $1',
        [earlier],
      )).toHaveLength(1);
      const ending = await revoker.withBusiness(randomUUID(), async (tx) => {
        await tx.query("set local lock_timeout = '200ms'");
        await endProviderSession(tx, randomUUID());
      }).then(() => 'committed', (error: { code?: string }) => error.code);
      expect(ending, 'a competing ending cannot commit after the copy while the reset holds its source lock').toBe('55P03');
    });
  } finally {
    await revoker.close();
    await db.drop();
  }
});
