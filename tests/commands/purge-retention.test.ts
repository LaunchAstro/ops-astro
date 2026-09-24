// SPDX-License-Identifier: AGPL-3.0-only
//
// `task.purge` reads the business's retention window, and nobody else's.
//
// Specification 14.3 purges the work class "after the business's retention
// window", and SPEC:319 with C12-5 Q46 put that window in the business
// settings table rather than the `task.purge` request body. Until this suite,
// the purge took `olderThanDays` from the caller and `retention_window_days`
// sat in `business_settings` read by nothing (root ruling 2, L3-RETENTION).
//
// Red at d38d649: a body with no `olderThanDays` was refused
// `FIELD_VALUE_INVALID`, so no case below reached the setting, and a body that
// carried one was obeyed.
//
// Every row here is synthetic and lives in a throwaway database. The windows
// are set through the settings writer and the trash is aged by moving
// `deleted_at` back, an hour either side of each window, so nothing sleeps.
// A missing or unusable window row is made by the admin connection, since no
// writer should be able to make one.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import {
  readAuditEvents,
  type AuditEventRow,
} from '../../packages/core-records/src/commands/audit.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'purge retention: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

type Request = Parameters<typeof executeCommand>[4];

/**
 * An event by what fixes it in the chain. The hash covers the event's content,
 * so the same id, place and hash is the same event.
 */
const chain = (events: readonly AuditEventRow[]) =>
  events.map((event) => [event.id, event.seq, event.hash, event.subject_record_id]);

/** Alpha keeps its trash ten days and bravo three, so one age sits between them. */
const WINDOWS = { alpha: 10, bravo: 3 } as const;

describe.skipIf(serverUrl === undefined)(
  'task.purge reads the retention window it is given',
  () => {
    let db: FreshDatabase;
    const business: Record<'alpha' | 'bravo', string> = { alpha: '', bravo: '' };
    const manager: Partial<Record<'alpha' | 'bravo', Member>> = {};

    const run = async (who: 'alpha' | 'bravo', request: Request) => {
      const member = manager[who];
      if (member === undefined) throw new Error(`no manager in ${who}`);
      return await executeCommand(db.app, business[who], member.presented, 'api', request);
    };

    const purge = async (
      who: 'alpha' | 'bravo',
      extra: Readonly<Record<string, unknown>> = {},
      operationId: string = randomUUID(),
    ) => await run(who, { command: 'task.purge', operationId, ...extra } as Request);

    const setWindow = async (who: 'alpha' | 'bravo', days: number) => {
      await db.app.withBusiness(business[who], async (tx) => {
        const written = await writeBusinessSetting(tx, {
          key: 'retention_window_days',
          value: days,
        });
        if (written === undefined || 'refused' in written) throw new Error('window not written');
      });
    };

    /** A task put in the trash `ageHours` ago, by the commands and then the clock. */
    const trashedAgo = async (who: 'alpha' | 'bravo', ageHours: number): Promise<string> => {
      const made = await run(who, {
        command: 'task.create',
        operationId: randomUUID(),
        fields: { title: `trashed ${String(ageHours)}h ago` },
      });
      if (isCommandRefusal(made)) throw new Error(`create refused ${made.code}`);
      const id = made.recordId ?? '';
      const trashed = await run(who, {
        command: 'task.trash',
        operationId: randomUUID(),
        recordId: id,
        expectedRevision: made.revision ?? 0,
      });
      if (isCommandRefusal(trashed)) throw new Error(`trash refused ${trashed.code}`);
      await db.admin.execute(
        `update records set deleted_at = now() - make_interval(hours => $3::int)
        where business_id = $1 and id = $2`,
        [business[who], id, ageHours],
      );
      return id;
    };

    /** Which of these records are still in the table. */
    const present = async (who: 'alpha' | 'bravo', ids: readonly string[]) =>
      new Set(
        (
          await db.admin.execute<{ readonly id: string }>(
            `select id::text as id from records where business_id = $1 and id = any ($2::uuid[])`,
            [business[who], ids],
          )
        ).map((row) => row.id),
      );

    const recordCount = async (who: 'alpha' | 'bravo') =>
      (
        await db.admin.execute<{ readonly count: string }>(
          `select count(*)::text as count from records where business_id = $1`,
          [business[who]],
        )
      )[0]?.count;

    const audit = async (who: 'alpha' | 'bravo') =>
      await db.app.withBusiness(business[who], readAuditEvents);

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'l3ret' });
      for (const who of ['alpha', 'bravo'] as const) {
        /* eslint-disable no-await-in-loop -- two businesses, one after the other */
        business[who] = await insertBusiness(db.app, `purge-${who}`);
        await installSpine(db.app, business[who]);
        await db.app.withBusiness(business[who], installBusinessSettings);
        const member = await enrol(db.app, business[who], `${who}-manager`);
        await db.app.withBusiness(business[who], async (tx) => {
          await grantTo(tx, member, 'write');
          await grantTo(tx, member, 'manage');
        });
        manager[who] = member;
        await setWindow(who, WINDOWS[who]);
        /* eslint-enable no-await-in-loop */
      }
    }, 60_000);

    afterAll(async () => {
      await db?.drop();
    });

    it('purges each business by its own window, an hour either side of it', async () => {
      const day = 24;
      const alpha = {
        old: await trashedAgo('alpha', WINDOWS.alpha * day + 1),
        recent: await trashedAgo('alpha', WINDOWS.alpha * day - 1),
        // Older than bravo's window and inside alpha's: only the reader of the
        // right business's row gets this one right.
        between: await trashedAgo('alpha', 5 * day),
      };
      const bravo = {
        old: await trashedAgo('bravo', WINDOWS.bravo * day + 1),
        recent: await trashedAgo('bravo', WINDOWS.bravo * day - 1),
        between: await trashedAgo('bravo', 5 * day),
      };

      const alphaPurge = await purge('alpha');
      if (isCommandRefusal(alphaPurge)) throw new Error(`alpha purge refused ${alphaPurge.code}`);
      expect(alphaPurge.detail['purged']).toBe(1);
      expect(await present('alpha', Object.values(alpha))).toStrictEqual(
        new Set([alpha.recent, alpha.between]),
      );
      // Alpha's purge reached nothing of bravo's, old or not.
      expect(await present('bravo', Object.values(bravo))).toStrictEqual(
        new Set(Object.values(bravo)),
      );

      const bravoPurge = await purge('bravo');
      if (isCommandRefusal(bravoPurge)) throw new Error(`bravo purge refused ${bravoPurge.code}`);
      expect(bravoPurge.detail['purged']).toBe(2);
      expect(await present('bravo', Object.values(bravo))).toStrictEqual(new Set([bravo.recent]));
      expect(await present('alpha', Object.values(alpha))).toStrictEqual(
        new Set([alpha.recent, alpha.between]),
      );
    });

    it('leaves the evidence class where it was', async () => {
      const doomed = await trashedAgo('alpha', WINDOWS.alpha * 24 + 1);
      const before = await audit('alpha');
      const purged = await purge('alpha');
      if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);
      expect(await present('alpha', [doomed])).toStrictEqual(new Set());

      // Every event that existed still exists, unchanged, and the purge added its
      // own.
      const after = await audit('alpha');
      expect(chain(after.slice(0, before.length))).toStrictEqual(chain(before));
      expect(
        after.slice(before.length).map((event) => [event.command, event.outcome]),
      ).toStrictEqual([['task.purge', 'applied']]);
      const register = await db.admin.execute<{ readonly count: string }>(
        `select count(*)::text as count from operations where business_id = $1 and record_id = $2`,
        [business.alpha, doomed],
      );
      expect(register[0]?.count).toBe('2');
    });

    it('refuses a caller-supplied window, any value, and changes nothing', async () => {
      const old = await trashedAgo('alpha', WINDOWS.alpha * 24 + 1);
      const recent = await trashedAgo('alpha', 1);
      for (const olderThanDays of [0, 30, 3650, -1, '0']) {
        /* eslint-disable no-await-in-loop -- one attempt at a time, each counted */
        const records = await recordCount('alpha');
        const before = await audit('alpha');
        const answer = await purge('alpha', { olderThanDays });
        expect(isCommandRefusal(answer) && answer.code, String(olderThanDays)).toBe(
          'COMMAND_BODY_INVALID',
        );
        expect(isCommandRefusal(answer) && answer.names).toStrictEqual(['olderThanDays']);
        expect(await recordCount('alpha')).toBe(records);
        expect(await present('alpha', [old, recent])).toStrictEqual(new Set([old, recent]));
        const added = (await audit('alpha')).slice(before.length);
        expect(
          added.map((event) => [event.command, event.outcome, event.refusal_code]),
        ).toStrictEqual([['task.purge', 'refused', 'COMMAND_BODY_INVALID']]);
        /* eslint-enable no-await-in-loop */
      }
      // The same trash, asked without the override, is purged by the window.
      const purged = await purge('alpha');
      if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);
      expect(await present('alpha', [old, recent])).toStrictEqual(new Set([recent]));
    });

    it('replays an applied purge with the result it stored', async () => {
      await trashedAgo('bravo', WINDOWS.bravo * 24 + 1);
      const operationId = randomUUID();
      const first = await purge('bravo', {}, operationId);
      if (isCommandRefusal(first)) throw new Error(`purge refused ${first.code}`);
      expect(first.detail['purged']).toBe(1);

      // Old enough, trashed after the first answer: a replay is not a new purge.
      const later = await trashedAgo('bravo', WINDOWS.bravo * 24 + 1);
      const again = await purge('bravo', {}, operationId);
      expect(again).toStrictEqual(first);
      expect(await present('bravo', [later])).toStrictEqual(new Set([later]));
      const outcomes = (await audit('bravo'))
        .filter((event) => event.operation_id === operationId)
        .map((event) => event.outcome);
      expect(outcomes).toStrictEqual(['applied', 'replayed']);
    });

    it('purges all of one business’s trash at a window of zero, and only that business’s', async () => {
      const alphaRecent = await trashedAgo('alpha', 1);
      const bravoTrash = [await trashedAgo('bravo', 1), await trashedAgo('bravo', 0)];
      await setWindow('bravo', 0);
      try {
        const purged = await purge('bravo');
        if (isCommandRefusal(purged)) throw new Error(`purge refused ${purged.code}`);
        const left = await db.admin.execute<{ readonly count: string }>(
          `select count(*)::text as count from records where business_id = $1 and deleted_at is not null`,
          [business.bravo],
        );
        expect(left[0]?.count).toBe('0');
        expect(await present('bravo', bravoTrash)).toStrictEqual(new Set());
        expect(await present('alpha', [alphaRecent])).toStrictEqual(new Set([alphaRecent]));
      } finally {
        await setWindow('bravo', WINDOWS.bravo);
      }
    });

    /**
     * One purge in alpha that has to be refused `code` naming the window, with
     * trash old enough under the real window still there and one refused row.
     */
    const refusedOnWindow = async (code: string, label: string) => {
      const old = await trashedAgo('alpha', WINDOWS.alpha * 24 + 1);
      const records = await recordCount('alpha');
      const before = await audit('alpha');
      const answer = await purge('alpha');
      expect(isCommandRefusal(answer) && answer.code, label).toBe(code);
      expect(isCommandRefusal(answer) && answer.names, label).toStrictEqual([
        'retention_window_days',
      ]);
      expect(await recordCount('alpha'), label).toBe(records);
      expect(await present('alpha', [old]), label).toStrictEqual(new Set([old]));
      const added = (await audit('alpha')).slice(before.length);
      expect(
        added.map((event) => [event.command, event.outcome, event.refusal_code]),
        label,
      ).toStrictEqual([['task.purge', 'refused', code]]);
    };

    // The bad rows are made through the admin connection, never a writer: the
    // settings writer is the one thing that should not be able to make them.
    const alphaWindowRow = async (set: string, parameters: readonly unknown[] = []) =>
      await db.admin.execute(
        `update business_settings set ${set}
          where business_id = $1 and key in ('retention_window_days', 'parked_retention_window_days')`,
        [business.alpha, ...parameters],
      );

    it('refuses NOT_FOUND when the business has no window row, and purges nothing', async () => {
      await alphaWindowRow(`key = 'parked_retention_window_days'`);
      try {
        await refusedOnWindow('NOT_FOUND', 'no row');
      } finally {
        await alphaWindowRow(`key = 'retention_window_days'`);
      }
    });

    // Timeout only (TEST-TIMEOUTS): this case ran past the 5 s default while the
    // machine was busy and passes alone; the assertions are unchanged.
    it('refuses a window that is null, a fraction or negative, and purges nothing', async () => {
      try {
        for (const [label, value] of [
          ['null', `'null'::jsonb`],
          ['fraction', `to_jsonb(1.5::numeric)`],
          ['negative', `to_jsonb(-1::numeric)`],
        ] as const) {
          /* eslint-disable no-await-in-loop -- one bad value at a time */
          await alphaWindowRow(`value = ${value}`);
          await refusedOnWindow('FIELD_VALUE_INVALID', label);
          /* eslint-enable no-await-in-loop */
        }
      } finally {
        await alphaWindowRow(`value = to_jsonb($2::numeric)`, [WINDOWS.alpha]);
      }
    }, 30_000);
  },
);
