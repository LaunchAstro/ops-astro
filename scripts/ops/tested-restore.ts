// SPDX-License-Identifier: AGPL-3.0-only
//
// The date of the last tested restore on the installation's database (ticket
// C55, carried from S0-3; migration 0070). The drill's receipt stays in the
// backup store, which the API cannot reach; a pass the store took is also
// stamped here, where `operations.read` reads it. The operator gate hands this
// to the drill (operator.ts, `recordTestedRestore`), and drill-acts.mjs calls
// it on a pass only.

import { AsyncLocalStorage } from 'node:async_hooks';
import { connectAsAdmin } from '../../packages/core-records/src/index.ts';

/** The restore drill's identity on the installation's database (migration 0070). */
const RESTORE_DRILL_ROLE = 'ops_astro_restore_drill';

/**
 * The carried archive whose pass is being stamped, if any (drill-acts.mjs runs
 * the gate's stamp inside it; the gate's stamp takes no argument). Its stamp is
 * written once: a re-run for an archive already stamped answers the date as
 * it stands (migrations/20261004072829_tested_restore_once_per_archive.sql).
 */
export const stampedArchive: AsyncLocalStorage<string> = new AsyncLocalStorage();

/**
 * A passed restore drill, stamped on the installation's database at `adminUrl`
 * through `ops.record_tested_restore()` as the drill's identity, which runs
 * that function and nothing else; the database dates it. Answers the date the
 * row now holds, as ISO 8601. Nothing about the drill is sent: no business,
 * person, archive or path.
 */
export async function recordTestedRestore(adminUrl: string): Promise<string> {
  const archive = stampedArchive.getStore();
  const admin = connectAsAdmin(adminUrl, { source: 'admin' });
  try {
    const rows = await admin.transaction(async (execute) => {
      if (archive !== undefined) {
        const first = await execute(
          'insert into ops.tested_restore_archives values ($1) on conflict do nothing returning 1',
          [archive],
        );
        if (first.length === 0)
          return await execute<{ at: Date }>('select at from ops.last_tested_restore');
      }
      await execute(`set local role ${RESTORE_DRILL_ROLE}`);
      return await execute<{ at: Date }>('select ops.record_tested_restore() as at');
    });
    const at = rows[0]?.at;
    if (at === undefined) throw new Error('the date of the last tested restore was not written');
    return new Date(at).toISOString();
  } finally {
    await admin.close();
  }
}
