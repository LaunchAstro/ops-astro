// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, the trash lane's continuation: withdrawing a share.
//
// R2-AUTHORITY-60, the revokeShare half: `refuseShare` required the record to
// be live for both of its callers, so a share on a trashed task could not be
// withdrawn. `revokeShare` answered NOT_FOUND and the grant stayed live.
//
// The controls pin every other refusal of both functions to the bytes it had,
// so the only answer that moves is revoking a share on a trashed record.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import {
  revokeShare,
  shareRecord,
  type ShareRequest,
} from '../../packages/core-records/src/authority/shares.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'final-r2-fr2-trash-cont: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

const NOT_FOUND = {
  ok: false,
  refusal: {
    code: 'NOT_FOUND',
    reason: 'no such record or person here',
    fix: 'check the identifiers',
  },
};

describe.skipIf(serverUrl === undefined)('final review round 2: revoking a share', () => {
  let db: FreshDatabase;
  let business: string;
  let ada: Member;
  let bystander: Member;
  let ext: Member;

  const run = async (command: Readonly<Record<string, unknown>>) =>
    await executeCommand(db.app, business, ada.presented, 'api', command as unknown as Request);

  const create = async () => {
    const made = await run({
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title: 'shared' },
    });
    if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
    return { id: made.recordId ?? '', revision: made.revision ?? 0 };
  };

  const trash = async (task: { readonly id: string; readonly revision: number }) => {
    const trashed = await run({
      command: 'task.trash',
      operationId: randomUUID(),
      recordId: task.id,
      expectedRevision: task.revision,
    });
    if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
  };

  const share = async (who: Member, request: ShareRequest) =>
    await db.app.withBusiness(business, async (tx) => await shareRecord(tx, who, request));

  const revoke = async (who: Member, request: ShareRequest) =>
    await db.app.withBusiness(business, async (tx) => await revokeShare(tx, who, request));

  const liveGrants = async (recordId: string) =>
    (
      await db.admin.execute<{ readonly count: string }>(
        `select count(*)::text as count from grants
          where business_id = $1 and scope_kind = 'record' and scope_id = $2
            and revoked_at is null`,
        [business, recordId],
      )
    )[0]?.count;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'fr2trashcont' });
    business = await insertBusiness(db.app, 'final-r2-fr2-trash-cont');
    await installSpine(db.app, business);
    ada = await enrol(db.app, business, 'ada');
    bystander = await enrol(db.app, business, 'bystander');
    ext = await enrol(db.app, business, 'ext');
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, ada, 'write');
      await grantTo(tx, ada, 'share');
    });
  }, 60_000);

  afterAll(async () => {
    await db?.drop();
  });

  it('withdraws a share on a trashed task', async () => {
    const task = await create();
    const request = { collection: 'task', recordId: task.id, personId: ext.personId };
    const shared = await share(ada, request);
    expect(shared.ok).toBe(true);
    await trash(task);

    expect(await revoke(ada, request)).toStrictEqual({ ok: true, value: 1 });
    expect(await liveGrants(task.id)).toBe('0');
  });

  it('still refuses to share a trashed task, with the same bytes', async () => {
    const task = await create();
    await trash(task);
    const request = { collection: 'task', recordId: task.id, personId: ext.personId };
    expect(await share(ada, request)).toStrictEqual(NOT_FOUND);
    expect(await liveGrants(task.id)).toBe('0');
  });

  it('answers every other refusal of both functions as before', async () => {
    const task = await create();
    const live = { collection: 'task', recordId: task.id, personId: ext.personId };
    // Another collection is asked about first, and ada's `share` is on tasks.
    const cases: readonly (readonly [string, ShareRequest, string])[] = [
      ['no such record', { ...live, recordId: randomUUID() }, 'NOT_FOUND'],
      ['no such person', { ...live, personId: randomUUID() }, 'NOT_FOUND'],
      ['a malformed record id', { ...live, recordId: 'not-a-uuid' }, 'NOT_FOUND'],
      ['another collection', { ...live, collection: 'task_state' }, 'SCOPE_NOT_GRANTED'],
    ];
    for (const [label, request, code] of cases) {
      /* eslint-disable no-await-in-loop -- one request at a time */
      const shared = await share(ada, request);
      const revoked = await revoke(ada, request);
      expect([label, shared.ok ? 'applied' : shared.refusal.code]).toStrictEqual([label, code]);
      expect([label, revoked]).toStrictEqual([label, shared]);
      if (code === 'NOT_FOUND') expect([label, revoked]).toStrictEqual([label, NOT_FOUND]);
      /* eslint-enable no-await-in-loop */
    }

    // No `share` grant: the authority refusal comes first, for a live task and
    // a trashed one alike, and both functions give the same one.
    const trashed = await create();
    await trash(trashed);
    for (const recordId of [task.id, trashed.id]) {
      /* eslint-disable no-await-in-loop -- one record at a time */
      const request = { ...live, recordId };
      const shared = await share(bystander, request);
      const revoked = await revoke(bystander, request);
      expect(shared.ok ? 'applied' : shared.refusal.code).toBe('SCOPE_NOT_GRANTED');
      expect(revoked).toStrictEqual(shared);
      /* eslint-enable no-await-in-loop */
    }
  });
});
