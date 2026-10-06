// SPDX-License-Identifier: AGPL-3.0-only
//
// Audit proof, PR #954 finding FIX1.1 (criterion 5). `access.end` checks the
// caller's `access:manage` before it waits for the business's access lock and
// never asks again once it holds it. Noah's ending of Mia waits behind Ada's
// revocation of Noah's one manager grant; when the revocation commits, Noah
// no longer holds the key and his ending must be refused.
//
// The interleaving is fixed, not raced for: a fixture transaction holds
// Noah's grant row `for update`, so Ada's revocation takes the access lock and
// waits on the row; Noah's ending is admitted and waits on the access lock;
// the fixture lets go. Ada, Noah and Mia are made up.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { resolveLogin } from '../../packages/core-records/src/identity/login-resolution.ts';
import {
  connect,
  type AdminConnection,
  type BusinessId,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { createFreshDatabase, databaseUrlFromEnvironment } from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

// The business's access lock (`lockAccess`), split into pg_locks' two halves.
const ACCESS_LOCK = `l.locktype = 'advisory'
   and l.database = (select oid from pg_database where datname = current_database())
   and l.classid::bigint = ((hashtextextended('access:' || $1, 0) >> 32) & 4294967295)
   and l.objid::bigint = (hashtextextended('access:' || $1, 0) & 4294967295)`;

/** A session holding the access lock while it waits on a row lock. */
const holdsAccessWaitsOnRow = `select count(*)::int as n from pg_locks l
   where ${ACCESS_LOCK} and l.granted
     and exists (select 1 from pg_locks w where w.pid = l.pid and not w.granted
                   and w.locktype in ('transactionid', 'tuple'))`;

/** A session waiting for the access lock. */
const waitsOnAccess = `select count(*)::int as n from pg_locks l
   where ${ACCESS_LOCK} and not l.granted`;

/** Polls, on the blocking transaction, until `sql` counts one, or 15 s pass. */
const until = async (
  execute: AdminConnection['execute'],
  sql: string,
  businessId: string,
): Promise<boolean> => {
  const deadline = Date.now() + 15_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- polling until the lock waits
    const [row] = await execute<{ readonly n: number }>(sql, [businessId]);
    if (Number(row?.n) >= 1) return true;
    if (Date.now() > deadline) return false;
    // eslint-disable-next-line no-await-in-loop -- as above
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
};

describe.skipIf(serverUrl === undefined)(
  'access.end after a revocation during its lock wait',
  () => {
    it('an ending admitted before its manager grant was revoked is refused', async () => {
      const db = await createFreshDatabase({ part: 'audit954fix11' });
      const serving = connect(db.appUrl, { source: 'runtime', max: 4 });
      try {
        const alpha = (await insertBusiness(db.app, 'alpha')) as BusinessId;
        await installSpine(db.app, alpha);
        const ada = await enrol(db.app, alpha, 'ada');
        const noah = await enrol(db.app, alpha, 'noah');
        const mia = await enrol(db.app, alpha, 'mia');
        const managerGrant = async (member: Member): Promise<string> =>
          await db.app.withBusiness(
            alpha,
            async (tx) => await grantTo(tx, member, 'manage', WHOLE_BUSINESS, false, 'access'),
          );
        await managerGrant(ada);
        const noahGrant = await managerGrant(noah);
        await managerGrant(mia);

        const miaState = async (): Promise<unknown> =>
          await db.app.withBusiness(alpha, async (tx) => ({
            memberships: await tx.query(
              `select id, active, ended_at from public.memberships where person_id = $1`,
              [mia.personId],
            ),
            actors: await tx.query(
              `select id, active, deactivated_at from public.actors where person_id = $1`,
              [mia.personId],
            ),
            endings: await tx.query(`select id from public.access_endings where person_id = $1`, [
              mia.personId,
            ]),
          }));
        const before = await miaState();

        const act = async (
          as: Member,
          body: Readonly<Record<string, unknown>>,
        ): Promise<string> => {
          const result = await executeCommand(serving, alpha, as.presented, 'api', {
            operationId: randomUUID(),
            ...body,
          } as Parameters<typeof executeCommand>[4]);
          return isCommandRefusal(result) ? result.code : 'ok';
        };

        let revoking: Promise<string> | undefined;
        let ending: Promise<string> | undefined;
        const seen = await db.admin.transaction(async (execute) => {
          await execute(
            `select 1 from public.grants where business_id = $1 and id = $2 for update`,
            [alpha, noahGrant],
          );
          revoking = act(ada, { command: 'access.revoke', grantId: noahGrant });
          void revoking.catch(() => undefined);
          const adaWaits = await until(execute, holdsAccessWaitsOnRow, alpha);
          ending = act(noah, { command: 'access.end', holderId: mia.personId });
          void ending.catch(() => undefined);
          const noahWaits = await until(execute, waitsOnAccess, alpha);
          return { adaWaits, noahWaits };
        });
        expect(seen, 'Ada holds the access lock on the row, Noah waits for it').toEqual({
          adaWaits: true,
          noahWaits: true,
        });
        if (revoking === undefined || ending === undefined) throw new Error('never sent');
        const revoked = await revoking;
        const ended = await ending;

        const after = await miaState();
        const session = await db.app.withBusiness(alpha, async (tx) => {
          const resolved = await resolveLogin(tx, mia.presented);
          return isCommandRefusal(resolved) ? resolved.code : 'resolved';
        });
        expect({ revoked, ended, mia: after, session }).toEqual({
          revoked: 'ok',
          ended: 'SCOPE_NOT_GRANTED',
          mia: before,
          session: 'resolved',
        });
      } finally {
        await serving.close();
        await db.drop();
      }
    }, 90_000);
  },
);
