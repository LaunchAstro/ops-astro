// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { endProviderSession } from '../../packages/core-records/src/identity/sessions.ts';
import { migrate } from '../../packages/core-records/src/tenancy/migrate.ts';
import { CARRY_ENDED_SESSIONS, RESTORE_ENDED_SESSIONS, TENANT_TABLES } from '../../scripts/ops/staging-reset.ts';
import { createFreshDatabase } from '../support/fresh-database.ts';

it('a session ended after the reset copies revocations remains ended after reset', async () => {
  const db = await createFreshDatabase({ part: 'sol_reset_end_race' });
  const revoker = connect(db.appUrl);
  const sessionId = randomUUID();
  const earlierSession = randomUUID();
  let ending: string | undefined;
  // Read the actual CLI's emptying statements, following its exported carry
  // statements in the same transaction. No second implementation of the copy.
  const source = readFileSync('scripts/ops/staging-reset.mjs', 'utf8');
  const body = /const EMPTY = \[([\s\S]*?)\];/u.exec(source)?.[1] ?? '';
  const empty = [...body.matchAll(/'([^']+)'/gu)].map((match) => match[1] ?? '');
  expect(empty).toContain('drop schema if exists ops cascade');
  try {
    await revoker.withBusiness(randomUUID(), (tx) => endProviderSession(tx, earlierSession));
    await db.admin.transaction(async (execute) => {
      const tables = (await execute<{ name: string }>(TENANT_TABLES)).map((row) => row.name);
      if (tables.length > 0) await execute(`lock table ${tables.join(', ')} in share mode`);
      for (const statement of CARRY_ENDED_SESSIONS) await execute(statement);
      // The copy has run, as the reset runs it: the earlier ending is carried.
      expect(await execute('select session_id from ops_astro_reset.ended_provider_sessions where session_id = $1', [earlierSession]),
        'the copy runs before the competing ending').toHaveLength(1);
      // A different backend ends the session after the copy, before DROP. The
      // reset's real locks stay held; a timeout distinguishes refusal from loss.
      ending = await revoker.withBusiness(randomUUID(), async (tx) => {
        await tx.query("set local lock_timeout = '200ms'");
        await endProviderSession(tx, sessionId);
      }).then(() => 'committed', (error: { code?: string }) => error.code);
      expect(['55P03', 'committed'], 'the competing ending is refused under its lock timeout, or commits').toContain(ending);
      expect(await execute('select session_id from ops.ended_provider_sessions where session_id = $1', [sessionId])).toHaveLength(ending === 'committed' ? 1 : 0);
      for (const statement of empty) await execute(statement);
    });
    await revoker.close();
    await migrate(db.admin, 'migrations');
    await db.admin.transaction(async (execute) => {
      for (const statement of RESTORE_ENDED_SESSIONS) await execute(statement);
    });
    expect(await db.admin.execute('select session_id from ops.ended_provider_sessions where session_id = $1', [earlierSession]),
      'positive control: a session ended before the copy remains ended').toHaveLength(1);
    expect(await db.admin.execute('select session_id from ops.ended_provider_sessions where session_id = $1', [sessionId]),
      'a revocation committed during reset must not disappear with the old ops schema').toHaveLength(ending === 'committed' ? 1 : 0);
  } finally {
    await revoker.close();
    await db.drop();
  }
});
