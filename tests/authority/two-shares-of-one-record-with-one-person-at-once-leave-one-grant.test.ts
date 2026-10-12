// SPDX-License-Identifier: AGPL-3.0-only
//
// Sharing a record with a person is idempotent: a live share of the same
// record with the same person is answered rather than issued again. That has
// to hold when two shares arrive at once on separate connections, not only
// one after the other, or the person ends up with two grants for one share.
//
// Each sharer's transaction pauses before it inserts a grant until the other
// has reached that point too, so both have read the record's live shares and
// found none. A sharer still waiting on a lock to make that read counts as
// having arrived: it cannot read until the first commits.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  issueShare,
  shareRecord,
  type ShareRequest,
} from '../../packages/core-records/src/authority/shares.ts';
import {
  connect,
  type AdminConnection,
  type TenantQuery,
} from '../../packages/core-records/src/tenancy/database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'two-shares-of-one-record-with-one-person-at-once-leave-one-grant: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

/**
 * Resolves for each of two callers once both have called it, or once some
 * backend of this database waits on an advisory lock (the other caller, which
 * cannot get here until the first has committed).
 */
function meeting(admin: Pick<AdminConnection, 'execute'>): () => Promise<void> {
  let arrived = 0;
  return async () => {
    arrived += 1;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (arrived === 2) return;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const rows = await admin.execute<{ waiting: boolean }>(
        `select exists (select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and wait_event = 'advisory') as waiting`,
      );
      if (rows[0]?.waiting === true) return;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(10);
    }
    throw new Error('the other share neither reached its insert nor waited on a lock');
  };
}

/** The transaction, paused at the meeting before any grant insert. */
const pausedBeforeInsert = (tx: TenantQuery, meet: () => Promise<void>): TenantQuery => ({
  businessId: tx.businessId,
  async query<Row>(text: string, parameters?: readonly unknown[]): Promise<readonly Row[]> {
    if (text.includes('insert into public.grants')) await meet();
    return await tx.query<Row>(text, parameters);
  },
});

const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let db: FreshDatabase;
let business: string;
let ada: Member;
let ext: Member;

const createTask = async (): Promise<string> => {
  const made = await executeCommand(db.app, business, ada.presented, 'api', {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'shared' },
  } as unknown as Request);
  if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
  return made.recordId ?? '';
};

/** Runs `share` on two connections at once, each paused before its insert. */
const twice = async (
  share: (tx: TenantQuery) => Promise<string>,
): Promise<readonly [string, string]> => {
  const meet = meeting(db.admin);
  const one = connect(db.appUrl);
  const two = connect(db.appUrl);
  try {
    const [first, second] = await Promise.all(
      [one, two].map(
        async (connection) =>
          await connection.withBusiness(
            business,
            async (tx) => await share(pausedBeforeInsert(tx, meet)),
          ),
      ),
    );
    return [first ?? '', second ?? ''];
  } finally {
    await Promise.all([one.close(), two.close()]);
  }
};

/** The person's unrevoked root read grants on the record. */
const unrevokedRootReads = async (request: ShareRequest): Promise<number> =>
  (
    await db.admin.execute<{ readonly count: number }>(
      `select count(*)::int as count from public.grants
        where business_id = $1 and subject_kind = 'person' and subject_id = $2
          and scope_kind = 'record' and scope_id = $3 and collection = $4
          and action = 'read' and parent_grant_id is null and revoked_at is null`,
      [business, request.personId, request.recordId, request.collection],
    )
  )[0]?.count ?? 0;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'shareonce' });
  business = await insertBusiness(db.app, 'two-shares-at-once');
  await installSpine(db.app, business);
  ada = await enrol(db.app, business, 'ada');
  ext = await enrol(db.app, business, 'ext');
  await db.app.withBusiness(business, async (tx) => {
    await grantTo(tx, ada, 'write');
    await grantTo(tx, ada, 'share');
  });
}, 60_000);

afterAll(async () => {
  await db?.drop();
});

it('two record shares at once answer one grant id and leave one grant', async () => {
  const request = { collection: 'task', recordId: await createTask(), personId: ext.personId };
  const ids = await twice(async (tx) => {
    const shared = await shareRecord(tx, ada, request);
    if (!shared.ok) throw new Error(`share refused ${shared.refusal.code}`);
    return shared.value;
  });

  expect({ ids: new Set(ids).size, grants: await unrevokedRootReads(request) }).toEqual({
    ids: 1,
    grants: 1,
  });
});

it('two authorised share issues at once answer one grant id and leave one grant', async () => {
  const request = { collection: 'task', recordId: await createTask(), personId: ext.personId };
  const ids = await twice(async (tx) => await issueShare(tx, ada.actorId, request));

  expect({ ids: new Set(ids).size, grants: await unrevokedRootReads(request) }).toEqual({
    ids: 1,
    grants: 1,
  });
});
