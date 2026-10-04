// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #429 at the column. An observed attempt's receipt link holding a
// run as long as a delegation credential (43 base64url characters) is refused
// by `attempts_receipt_link_shape`, as the worker's `CREDENTIAL_RUN` refuses
// it; a 42-character run is still stored. The check is added to a database
// migrated to the head before it, with observed links already stored, and
// rewrites none of them.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEmptyDatabase,
  databaseUrlFromEnvironment,
  type EmptyDatabase,
} from '../support/fresh-database.ts';
import {
  applyMigrations,
  migrate,
  readMigrations,
} from '../../packages/core-records/src/tenancy/migrate.ts';
import type { Database } from '../../packages/core-records/src/tenancy/database.ts';
import { propose } from '../../packages/core-runtime/src/propose.ts';
import { decide } from '../../packages/core-runtime/src/decide.ts';
import {
  buildFixture,
  newTask,
  stepPlanRecord,
  subjectsOf,
  TASK_COLLECTION,
  TEST_SIGNING_KEY,
  type RuntimeFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/receipt-link-column: DATABASE_URL is unset, so nothing below ran.');
}

const RUN_CHECK = '20261004100647';
const BEFORE_RUN_CHECK = readMigrations('migrations').filter((m) => m.version !== RUN_CHECK);
const linkWithRun = (length: number): string =>
  `https://receipts.example/effects/${'aB3_-'.repeat(9).slice(0, length)}`;

/** One approved piece of work's attempt, held and not yet observed. */
async function heldAttempt(database: Database, fixture: RuntimeFixture): Promise<string> {
  const taskId = await newTask(database, fixture.businessId, fixture.decider);
  return await database.withBusiness(fixture.businessId, async (tx) => {
    const proposed = await propose(tx, {
      taskId,
      collection: TASK_COLLECTION,
      proposedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      purpose: `rlrun_${randomUUID().slice(0, 8)}`,
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { change: 'a comment' },
      step: { kind: 'synthetic_comment', payload: {} },
      planRecordId: await stepPlanRecord(tx),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    if (!proposed.ok) throw new Error(`propose refused ${proposed.refusal.code}`);
    const decided = await decide(tx, {
      gateId: proposed.value.gateId,
      versionId: proposed.value.versionId,
      decidedByPersonId: fixture.decider.personId,
      decidedByActorId: fixture.decider.actorId,
      subjects: subjectsOf(fixture.decider),
      collection: TASK_COLLECTION,
      decision: 'approve',
      note: 'go',
      signingKey: TEST_SIGNING_KEY,
      capId: fixture.capId,
    });
    if (!decided.ok || decided.value.decision !== 'approve') throw new Error('decide refused');
    const attempt = await tx.query<{ readonly id: string }>(
      'select id from public.attempts where business_id = $1 and reservation_id = $2',
      [tx.businessId, decided.value.reservationId],
    );
    return String(attempt[0]?.id);
  });
}

describe.skipIf(serverUrl === undefined)(
  'the receipt link column and a credential-length run',
  () => {
    let db: EmptyDatabase;
    let fixture: RuntimeFixture;
    let storedBefore: unknown;
    let storedAfter: unknown;

    /** Dispatches the attempt and records the link as observed, as the application role. */
    const observe = (attemptId: string, link: string): Promise<void> =>
      db.app.withBusiness(fixture.businessId, async (tx) => {
        await tx.query(
          `update public.attempts
              set state = 'dispatched', dispatch_marker = true, observed = true, receipt_link = $2
            where id = $1`,
          [attemptId, link],
        );
      });

    const stored = async (): Promise<unknown> =>
      await db.admin.execute('select id, observed, receipt_link from public.attempts order by id');

    beforeAll(async () => {
      db = await createEmptyDatabase({ part: 'rlrun' });
      await applyMigrations(db.admin, BEFORE_RUN_CHECK);
      fixture = await buildFixture(db.app, 'rlrun');
      await observe(
        await heldAttempt(db.app, fixture),
        `https://receipts.example/effects/${randomUUID()}`,
      );
      await observe(await heldAttempt(db.app, fixture), linkWithRun(42));
      storedBefore = await stored();
      await db.closeSessions();
      await migrate(db.admin, 'migrations');
      storedAfter = await stored();
    }, 180_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('is added over stored observed links and rewrites none of them', () => {
      expect(storedBefore).toHaveLength(2);
      expect(storedAfter).toStrictEqual(storedBefore);
    });

    it('refuses an observed link holding a 43-character run, as the application role', async () => {
      const attemptId = await heldAttempt(db.app, fixture);
      await expect(observe(attemptId, linkWithRun(43))).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'attempts_receipt_link_shape',
      });
      const [row] = await db.admin.execute<{ readonly receipt_link: string | null }>(
        'select receipt_link from public.attempts where id = $1',
        [attemptId],
      );
      expect(row?.receipt_link).toBeNull();
    });

    it('still stores an observed link whose longest run is 42 characters', async () => {
      const attemptId = await heldAttempt(db.app, fixture);
      await observe(attemptId, linkWithRun(42));
      const [row] = await db.admin.execute<{ readonly receipt_link: string | null }>(
        'select receipt_link from public.attempts where id = $1',
        [attemptId],
      );
      expect(row?.receipt_link).toBe(linkWithRun(42));
    });
  },
);
