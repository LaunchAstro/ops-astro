// SPDX-License-Identifier: AGPL-3.0-only
//
// An agent credential's `task.update` is admitted on its issuer's grants,
// then waits on the task row. While it waits, an administrator revokes the
// issuer's only `task:write` grant and that commits. The write must not then
// go through on the revoked authority: it is refused SCOPE_NOT_GRANTED and the
// task is unchanged, or the revocation waits for a writer whose authority is
// held through its commit.
//
// Three connections: the row holder on the owner connection, the credential
// request on the world's app pool, and the revocation on a second app pool
// (`rebuildApi`).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pathOf } from '../../packages/core-wire/src/index.ts';
import type { AdminConnection } from '../../packages/core-records/src/tenancy/database.ts';
import {
  agentPath,
  bearer,
  call,
  createWorld,
  personPath,
  rebuildApi,
  serverUrl,
  type Answer,
  type World,
} from '../acceptance/world.ts';
import { grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';

if (serverUrl === undefined) {
  console.warn(
    'api/a-credential-write-waiting-on-its-task-lock: DATABASE_URL is unset, so nothing below ran.',
  );
}

/**
 * A session waiting on a row the row holder's transaction holds. That
 * transaction holds T alone, and nothing before the grant check reads T, so
 * this is `lockTask` waiting. Matched on the wait, not the statement text,
 * which a pipelined client can leave naming an earlier statement.
 */
const UPDATE_WAITING = `select count(*)::int as n from pg_stat_activity
   where datname = current_database() and wait_event_type = 'Lock'
     and wait_event = 'transactionid'`;
const LOCK_WAITERS = `select count(*)::int as n from pg_stat_activity
   where datname = current_database() and wait_event_type = 'Lock'`;

const count = async (execute: AdminConnection['execute'], text: string): Promise<number> =>
  Number((await execute<{ readonly n: number }>(text, []))[0]?.n ?? 0);

const ACTIVITY = `select state, wait_event_type, wait_event, left(regexp_replace(query, '\\s+', ' ', 'g'), 120) as query
   from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`;

/** Polls until `done` holds or 60 s pass. */
const until = async (done: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 60_000;
  // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
  while (!(await done()) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
};

describe.skipIf(serverUrl === undefined)('a credential write and a revocation of its grant', () => {
  let world: World;

  beforeAll(async () => {
    world = await createWorld('credwritelockrevoke');
  }, 180_000);
  afterAll(async () => {
    await world?.close();
  });

  it("a credential write waiting on the task lock is refused once its issuer's grant is revoked", async () => {
    const noah = world.noah as unknown as Member;
    const grantId = await world.db.app.withBusiness(world.alpha, async (tx) => {
      const g = await grantTo(tx, noah, 'write', WHOLE_BUSINESS, false, 'task');
      await grantTo(tx, noah, 'write', WHOLE_BUSINESS, false, 'credential');
      return g;
    });
    const made = await call(
      world.api,
      personPath('alpha', pathOf('task.create')),
      { operationId: randomUUID(), fields: { title: 'before revocation' } },
      bearer(world.ada.token),
    );
    expect(made.status, made.text).toBe(200);
    const recordId = String(made.body['recordId']);
    const revision = made.body['revision'];
    const issued = await call(
      world.api,
      personPath('alpha', pathOf('credential.issue')),
      {
        operationId: randomUUID(),
        scope: [{ collection: 'task', action: 'write' }],
        purpose: 'a write raced by a revocation',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      bearer(world.noah.token),
    );
    expect(issued.status, issued.text).toBe(200);
    const credential = (issued.body['detail'] as { readonly credential?: unknown } | undefined)
      ?.credential;
    if (typeof credential !== 'string') throw new Error(`credential missing: ${issued.text}`);

    const revoker = rebuildApi(world);
    let updating: Promise<Answer> | undefined;
    let revoked: Answer | undefined;
    let revokeWaited = false;
    try {
      await world.db.admin.transaction(async (execute) => {
        const held = await execute(
          'select id from public.records where business_id = $1 and id = $2 for update',
          [world.alpha, recordId],
        );
        expect(held.length, 'the row holder holds T').toBe(1);
        let updateSettled = false;
        updating = call(
          world.api,
          agentPath('alpha', pathOf('task.update')),
          {
            operationId: randomUUID(),
            recordId,
            expectedRevision: revision,
            fields: { title: 'after revocation' },
          },
          bearer(credential),
        );
        const updateDone = (): void => {
          updateSettled = true;
        };
        void updating.then(updateDone, updateDone);
        await until(async () => updateSettled || (await count(execute, UPDATE_WAITING)) >= 1);
        if ((await count(execute, UPDATE_WAITING)) !== 1) {
          const activity = await execute(ACTIVITY, []);
          const answer = updateSettled ? (await updating).text : 'still pending';
          throw new Error(
            `setup: the update is not waiting on T; update=${answer}; activity=${JSON.stringify(activity)}`,
          );
        }

        let revokeSettled = false;
        const revoking = call(
          revoker.api,
          personPath('alpha', pathOf('access.revoke')),
          { operationId: randomUUID(), grantId },
          bearer(world.ada.token),
        );
        const settle = (): void => {
          revokeSettled = true;
        };
        void revoking.then(settle, settle);
        // Either the revocation commits, or it waits behind the writer.
        await until(async () => revokeSettled || (await count(execute, LOCK_WAITERS)) >= 2);
        if (!revokeSettled) {
          revokeWaited = true;
          return;
        }
        revoked = await revoking;
        expect(revoked.status, revoked.text).toBe(200);
        const [grant] = await execute<{ readonly revoked: boolean }>(
          'select revoked_at is not null as revoked from public.grants where id = $1',
          [grantId],
        );
        expect(grant?.revoked, 'G is revoked and committed').toBe(true);
      });
      if (updating === undefined) throw new Error('the update was never sent');
      const updated = await updating;
      if (revokeWaited) {
        // The other half of Expected: revocation waited for the writer.
        expect(updated.status, updated.text).toBe(200);
        return;
      }
      const [row] = await world.db.admin.execute<{
        readonly title: string;
        readonly revision: number;
      }>(
        "select data ->> 'title' as title, revision::int as revision from public.records where id = $1",
        [recordId],
      );
      expect({ code: updated.code, row }, updated.text).toEqual({
        code: 'SCOPE_NOT_GRANTED',
        row: { title: 'before revocation', revision: Number(revision) },
      });
    } finally {
      await revoker.close();
    }
  }, 240_000);
});
