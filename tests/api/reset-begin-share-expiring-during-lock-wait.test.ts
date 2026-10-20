// SPDX-License-Identifier: AGPL-3.0-only
//
// An external client's only share expires while `beginPasswordReset` waits on
// the login's factor lock. Begin judges the share after the wait, so it opens
// no window. Copied from the reset's second review (#1656), body unchanged.

import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { beginPasswordReset } from '../../packages/core-commands/src/commands/password-reset.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { lockLoginFactors } from '../../packages/core-records/src/identity/second-factor.ts';
import {
  insertBusiness,
  insertPerson,
  insertActor,
  insertLogin,
  insertMapping,
} from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
async function client(business = alpha, subject = randomUUID()) {
  return await db.app.withBusiness(business, async (tx) => {
    const person = await insertPerson(tx, 'External');
    const actor = await insertActor(tx, person);
    const login = await insertLogin(tx, subject);
    await insertMapping(tx, login, person, actor);
    return { business, subject, person, actor };
  });
}
async function grant(
  c: Awaited<ReturnType<typeof client>>,
  options: {
    actor?: boolean;
    business?: boolean;
    action?: 'read' | 'write' | 'comment';
    expiresAt?: Date;
  } = {},
) {
  return await db.app.withBusiness(c.business, async (tx) => {
    const answer = await issueGrant(tx, [], {
      subject: { kind: options.actor ? 'actor' : 'person', id: options.actor ? c.actor : c.person },
      scope: options.business
        ? { kind: 'business', id: null }
        : { kind: 'record', id: randomUUID() },
      collection: 'task',
      action: options.action ?? 'read',
      parentGrantId: null,
      grantedByActorId: c.actor,
      expiresAt: options.expiresAt ?? null,
    });
    if (!answer.ok) throw new Error('grant refused');
    return answer.value;
  });
}
/** Whether a session is seen waiting on an advisory lock within a second. */
async function advisoryLockWaited() {
  for (let i = 0; i < 100; i++) {
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    const [row] = await db.admin.execute<{ waiting: boolean }>(`select exists (
        select 1 from pg_locks where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())) as waiting`);
    if (row?.waiting) return true;
    // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
    await delay(10);
  }
  return false;
}
async function shareExpiringDuringTheWait() {
  const c = await client();
  const expiresAt = new Date(Date.now() + 2200);
  await grant(c, { expiresAt });
  const sentAt = new Date().toISOString();
  const digest = createHash('sha256').update(c.subject).digest('hex');
  await db.admin.execute(
    `insert into ops.recovery_links (id, subject_digest, minted_at, provider_sent_at)
    values (gen_random_uuid(), $1, clock_timestamp() - interval '5 seconds', $2::timestamptz)`,
    [digest, sentAt],
  );
  let unlock!: () => void;
  let locked!: () => void;
  const release = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const lockConnection = connect(db.appUrl);
  const holder = lockConnection.withBusiness(alpha, async (tx) => {
    await lockLoginFactors(tx, c.subject);
    locked();
    await release;
  });
  await ready;
  const now = Math.floor(Date.now() / 1000);
  const pending = beginPasswordReset(db.app, {
    subject: c.subject,
    sessionId: randomUUID(),
    signedInAt: now,
    expiresAt: now + 600,
    providerSentAt: sentAt,
  });
  try {
    expect(await advisoryLockWaited()).toBe(true);
    await delay(Math.max(0, expiresAt.getTime() - Date.now()) + 100);
  } finally {
    unlock();
  }
  await holder;
  await lockConnection.close();
  const answer = await pending;
  const [expired] = await db.admin.execute<{ expired: boolean }>(
    'select clock_timestamp() > $1::timestamptz as expired',
    [expiresAt],
  );
  expect(expired?.expired).toBe(true);
  expect(answer).toStrictEqual({ ok: false, code: 'RESET_LINK_INVALID' });
}

describe.skipIf(serverUrl === undefined)('begin under the factor lock', () => {
  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'rstlockexp' });
    alpha = await insertBusiness(db.app, 'alpha');
  });
  afterAll(async () => {
    await db?.drop();
  });
  it(
    'a share expiring during the factor lock wait cannot open a reset',
    shareExpiringDuringTheWait,
  );
});
