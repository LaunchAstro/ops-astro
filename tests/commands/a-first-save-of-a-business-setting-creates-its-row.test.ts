// SPDX-License-Identifier: AGPL-3.0-only
//
// The first Save of a business setting creates its row (owner decision on
// #1393). A business with no row for a setting draws it empty on Settings
// General and offers Save; the save creates that one row from its shipped
// definition and writes the value on it, under the settings install lock, so
// a money reader that found the row absent (and so used the shipped band)
// commits first. Nothing else is created: another setting stays absent, a key
// another operation owns stays NOT_FOUND, and a save that rolls back leaves no
// row. Two first saves at once make one row; a replay makes nothing more.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { enrol, grantTo, installSpine, type Member } from './fixture.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import {
  lockSettingsInstall,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A promise and the call that settles it, for holding one transaction open. */
function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, open: () => settle?.() };
}

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('the first save of a business setting', () => {
  let db: FreshDatabase;
  let second: Database;
  let alpha: string;
  let lead: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'firstrow' });
    second = connect(db.appUrl, { source: 'runtime' });
    alpha = await insertBusiness(db.app, 'first-row');
    await installSpine(db.app, alpha);
    lead = await enrol(db.app, alpha, 'lead');
    await db.app.withBusiness(alpha, async (tx) => {
      await grantTo(tx, lead, 'read', { kind: 'business', id: null }, false, 'settings');
      await grantTo(tx, lead, 'manage', { kind: 'business', id: null }, false, 'settings');
      await grantTo(tx, lead, 'decide', { kind: 'business', id: null }, false, 'spend');
    });
  }, 120_000);

  afterAll(async () => {
    await second?.close();
    await db?.drop();
  });

  beforeEach(async () => {
    await db.admin.execute('delete from public.business_settings where business_id = $1', [alpha]);
  });

  const setBand = async (value: number, on: Database = db.app, operationId = randomUUID()) =>
    await executeCommand(on, alpha, lead.presented, 'api', {
      command: 'settings.set_four_eyes_threshold',
      operationId,
      value,
    } as never);

  const settings = async () => {
    const read = await executeRead(db.app, alpha as never, lead.presented, {
      read: 'settings.read',
    } as never);
    if (!('settings' in read)) throw new Error(`settings.read refused: ${JSON.stringify(read)}`);
    return (read.settings as readonly { key: string; value: unknown; revision: number }[]).map(
      ({ key, value, revision }) => ({ key, value, revision }),
    );
  };

  const keys = async (): Promise<readonly string[]> =>
    (
      await db.admin.execute<{ key: string }>(
        'select key from public.business_settings where business_id = $1 order by key',
        [alpha],
      )
    ).map((row) => row.key);

  it('saving 640 where no settings row exists creates the threshold an authorised reread shows', async () => {
    expect(await settings()).toStrictEqual([]);
    const saved = await setBand(640);
    expect(saved, JSON.stringify(saved)).not.toHaveProperty('refused');
    expect(await settings()).toStrictEqual([
      { key: 'four_eyes_threshold', value: 640, revision: 2 },
    ]);
  });

  it('creates only the saved setting, and no key another operation owns', async () => {
    await setBand(700);
    expect(await keys()).toStrictEqual(['four_eyes_threshold']);
    const elsewhere = await db.app.withBusiness(alpha, async (tx) => [
      await writeBusinessSetting(tx, {
        key: 'retention_window_days',
        value: 40,
        owningOperation: 'settings.set_four_eyes_threshold',
      }),
      await writeBusinessSetting(tx, {
        key: 'no_such_setting',
        value: 1,
        owningOperation: 'settings.set_four_eyes_threshold',
      }),
    ]);
    expect(elsewhere).toStrictEqual([undefined, undefined]);
    expect(await keys()).toStrictEqual(['four_eyes_threshold']);
  });

  it('a first save that rolls back leaves no row', async () => {
    await expect(
      db.app.withBusiness(alpha, async (tx) => {
        await writeBusinessSetting(tx, {
          key: 'four_eyes_threshold',
          value: 800,
          owningOperation: 'settings.set_four_eyes_threshold',
        });
        throw new Error('crash after the first save');
      }),
    ).rejects.toThrow('crash after the first save');
    expect(await keys()).toStrictEqual([]);
  });

  it('a replayed first save answers its first outcome and creates nothing more', async () => {
    const operationId = randomUUID();
    const first = await setBand(650, db.app, operationId);
    const again = await setBand(650, db.app, operationId);
    expect(again).toStrictEqual(first);
    expect(await settings()).toStrictEqual([
      { key: 'four_eyes_threshold', value: 650, revision: 2 },
    ]);
  });

  it('two first saves at once make one row, the second written on the first', async () => {
    const answers = await Promise.all([setBand(610, db.app), setBand(620, second)]);
    for (const answer of answers)
      expect(answer, JSON.stringify(answer)).not.toHaveProperty('refused');
    const [row] = await settings();
    expect(await keys()).toStrictEqual(['four_eyes_threshold']);
    expect(row?.revision).toBe(3);
    expect([610, 620]).toContain(row?.value);
  });

  it('a first save waits for a reader that found the row absent under the install lock', async () => {
    const held = latch();
    const holding = latch();
    const reader = second.withBusiness(alpha as never, async (tx) => {
      await lockSettingsInstall(tx, 'shared');
      const rows = await tx.query(
        "select 1 from public.business_settings where business_id = $1 and key = 'four_eyes_threshold'",
        [alpha],
      );
      holding.open();
      await held.promise;
      return rows.length;
    });
    await holding.promise;
    let settled = false;
    const save = setBand(660).then((answer) => {
      settled = true;
      return answer;
    });
    try {
      await sleep(1_000);
      expect(settled).toBe(false);
    } finally {
      held.open();
    }
    expect(await reader).toBe(0);
    expect(await save).not.toHaveProperty('refused');
    expect(await settings()).toStrictEqual([
      { key: 'four_eyes_threshold', value: 660, revision: 2 },
    ]);
  });
});
