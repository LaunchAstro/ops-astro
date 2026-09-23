// SPDX-License-Identifier: AGPL-3.0-only
//
// N6-N7: authority the request cannot talk its way past.
//
// N7 is input tampering: a valid session that also posts a business key, an
// actor id and forwarded headers of its own. The server must take the caller
// from the session and ignore the rest.
//
// N6 is revocation while the page is open, and it runs in `n6-revocation.mjs`,
// which is a module of its own because it is also runnable alone. It is fenced
// here so that a failure inside it cannot take B7 and B6 with it: those two are
// the owner's persistence proof and are worth more than this script's control
// flow. The grant it revokes is put back through the authority path afterwards.

import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { WEB, record, serverRevision, shot, throughClient, users } from './harness.mjs';
import { n6Cases } from './n6-revocation.mjs';

export async function caseN7(run) {
  const { page, state } = run;
  const tampered = await page.evaluate(
    async (given) => {
      const session = JSON.parse(sessionStorage.getItem('ops-astro.session'));
      const response = await window.fetch('/api/b/alpha/task/update', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.token}`,
          'x-forwarded-host': 'bravo.local',
          'x-actor-id': '00000000-0000-0000-0000-000000000000',
        },
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          recordId: given.taskId,
          expectedRevision: given.revision,
          businessKey: 'bravo',
          actorId: '00000000-0000-0000-0000-000000000000',
          fields: { priority: 6 },
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { taskId: state.taskId, revision: await serverRevision(page, state.taskId) },
  );
  const sentKeys = (
    await throughClient(page, { read: true, name: 'task.read', body: { recordId: state.taskId } })
  ).sent;
  record({
    case: 'N7 auth input tampering',
    action: 'a valid session posting businessKey/actorId in the body and forwarded headers',
    observed: `HTTP ${tampered.status}, ${JSON.stringify(tampered.body).slice(0, 120)}; the client sends only ${JSON.stringify(sentKeys[0]?.headers ?? [])}`,
    ok: tampered.status === 200,
    shot: await shot(page, 'N7-tampering-ignored'),
  });
}

export async function casesN6(run) {
  const { page, database, admin, alpha, state } = run;
  let miaPerson;
  try {
    await page.goto(`${WEB}/task/${encodeURIComponent(state.taskKey)}`, {
      waitUntil: 'domcontentloaded',
    });
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
