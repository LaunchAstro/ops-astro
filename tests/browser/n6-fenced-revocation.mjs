// SPDX-License-Identifier: AGPL-3.0-only
//
// N6, revocation while the page is open, fenced for the slice run. The cases
// themselves are in `n6-revocation.mjs`; this fence records a failure inside
// them as one failed N6 row, so it cannot take B7 and B6 with it, and puts the
// revoked grant back through the authority path afterwards. `cases-n6-n7.mjs`
// hands `casesN6` on to the entry point beside N7.

import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { WEB, record, servedBuild, shot, users } from './harness.mjs';
import { n6Cases } from './n6-revocation.mjs';

export async function casesN6(run) {
  const { page, database, admin, alpha, state } = run;
  let miaPerson;
  try {
    await page.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
      waitUntil: 'domcontentloaded',
    });
    // Which build served this page (S0-1, line C8).
    await servedBuild(page, 'N6');
    const { records, personId } = await n6Cases({
      page,
      database,
      admin,
      businessId: alpha,
      login: users.find((user) => user.email === 'mia@alpha.local'),
      shot: async (name) => await shot(page, name),
    });
    miaPerson = personId;
    for (const entry of records) record(entry);
  } catch (error) {
    record({
      case: 'N6 revocation on the mounted page',
      action: 'revoke through revokeGrant with the page open, then press Refresh',
      observed: `the script did not reach the assertion: ${String(error).slice(0, 200)}`,
      ok: false,
      shot: await shot(page, 'N6-failed').catch(() => undefined),
    });
  }
  if (miaPerson !== undefined) await restoreTaskRead(database, alpha, miaPerson);
}

/** Put the revoked grant back the way the seed says it should be. */
export async function restoreTaskRead(database, businessId, personId) {
  await database.withBusiness(businessId, async (tx) => {
    const actor = (
      await tx.query(`select id from public.actors where person_id = $1 limit 1`, [personId])
    )[0]?.id;
    await issueGrant(tx, [], {
      subject: { kind: 'person', id: personId },
      scope: { kind: 'business', id: null },
      collection: 'task',
      action: 'read',
      parentGrantId: null,
      grantedByActorId: actor,
    });
  });
}
