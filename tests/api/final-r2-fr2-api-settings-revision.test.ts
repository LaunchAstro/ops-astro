// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2, R2-SURFACE-67: a mistyped `expectedRevision` on a
// settings command is an operand refusal, not a stale write.
//
// The settings commands target no existing record, so the envelope's number
// check on `expectedRevision` does not run for them, and the value reaches the
// settings writer as the caller sent it. A string "1", a null or a 1.5 compared
// against the row's revision is never equal, and the caller was told
// `VERSION_STALE` naming the very revision it had sent, which a client that
// retries with the named revision loops on. API.md keeps `VERSION_STALE` for a
// revision the row has moved past and lists `FIELD_VALUE_INVALID` for these
// commands. The composition is `settings-revision-routes.test.ts`'s.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { createApi } from '../../apps/api/app.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('final-r2 settings revision: DATABASE_URL is unset, so nothing below ran.');
}

const BUSINESS_KEY = 'alpha';

interface SettingRow {
  readonly key: string;
  readonly value: number | boolean | string | null;
  readonly revision: number;
}

describe.skipIf(serverUrl === undefined)(
  'R2-SURFACE-67: a mistyped settings revision over HTTP',
  () => {
    let db: FreshDatabase;
    let alpha: string;
    let mia: Member;
    let api: ReturnType<typeof createApi>;

    const post = async (name: CommandName, body: unknown, who: Member = mia) =>
      await api.fetch(
        new Request(`http://api.test/api/b/${BUSINESS_KEY}${pathOf(name)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${who.presented.subject}`,
          },
          body: JSON.stringify(body),
        }),
      );

    /** Every setting as the read surface serves it, over the same boundary. */
    const settings = async (): Promise<readonly SettingRow[]> => {
      const response = await post('settings.read' as CommandName, {});
      expect(response.status).toBe(200);
      const body = (await response.json()) as { readonly settings: readonly SettingRow[] };
      return body.settings;
    };

    const bandRow = async (): Promise<SettingRow | undefined> =>
      (await settings()).find((setting) => setting.key === 'four_eyes_threshold');

    beforeAll(async () => {
      db = await createFreshDatabase({ part: 'r2fr2apirev' });
      alpha = await insertBusiness(db.app, BUSINESS_KEY);
      await installSpine(db.app, alpha);
      await db.app.withBusiness(alpha, async (tx) => {
        await installBusinessSettings(tx);
      });
      mia = await enrol(db.app, alpha, 'mia');
      await db.app.withBusiness(alpha, async (tx) => {
        await grantTo(tx, mia, 'read');
        await grantTo(tx, mia, 'read', { kind: 'business', id: null }, false, 'settings');
        await grantTo(tx, mia, 'manage', { kind: 'business', id: null }, false, 'settings');
      });

      api = createApi({
        database: db.app,
        // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
        verify: async (request) => {
          const header = request.header('authorization') ?? '';
          const subject = header.replace(/^Bearer /u, '');
          return subject === '' ? undefined : { provider: 'supabase', subject };
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- the port is async
        resolveBusiness: async (key) => (key === BUSINESS_KEY ? alpha : undefined),
        executeCommand,
        executeRead,
      });
    }, 60_000);

    afterAll(async () => await db?.drop());

    const refusedCount = async (): Promise<number> =>
      await db.app.withBusiness(alpha, async (tx) => {
        const rows = await tx.query<{ readonly n: number }>(
          `select count(*)::int as n from audit_events
          where actor_id = $1 and command = 'settings.set_four_eyes_threshold'
            and outcome = 'refused'`,
          [mia.actorId],
        );
        return rows[0]?.n ?? 0;
      });

    it.each([
      ['the string "1"', '1'],
      ['null', null],
      ['1.5', 1.5],
    ])(
      'refuses expectedRevision %s 422 FIELD_VALUE_INVALID and writes nothing',
      async (_, sent) => {
        const before = await bandRow();
        const refusedBefore = await refusedCount();
        const response = await post('settings.set_four_eyes_threshold', {
          operationId: `band-${randomUUID()}`,
          value: 750,
          expectedRevision: sent,
        });
        const refusal = (await response.json()) as {
          readonly code: string;
          readonly names: readonly string[];
        };
        expect({ status: response.status, code: refusal.code, names: refusal.names }).toStrictEqual(
          {
            status: 422,
            code: 'FIELD_VALUE_INVALID',
            names: ['expectedRevision'],
          },
        );
        expect(await bandRow()).toStrictEqual(before);
        expect(await refusedCount()).toBe(refusedBefore + 1);
      },
    );

    it('still answers a whole-number revision the row has moved past 409 VERSION_STALE (control)', async () => {
      const current = await bandRow();
      const applied = await post('settings.set_four_eyes_threshold', {
        operationId: `band-${randomUUID()}`,
        value: 760,
        expectedRevision: current?.revision,
      });
      expect(applied.status).toBe(200);
      const stale = await post('settings.set_four_eyes_threshold', {
        operationId: `band-${randomUUID()}`,
        value: 770,
        expectedRevision: current?.revision,
      });
      expect(stale.status).toBe(409);
      expect(((await stale.json()) as { readonly code: string }).code).toBe('VERSION_STALE');
    });
  },
);
