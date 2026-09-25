// SPDX-License-Identifier: AGPL-3.0-only
//
// The two settings commands, writing against the revision the caller read.
//
// 0020 gave `business_settings` a revision and `records/business-settings.ts`
// the writer that compares it under a row lock. Until the commands call that
// writer the mechanism existed and nothing on the command path used it: two
// administrators editing the band from two browser tabs both applied, and the
// second silently replaced a value chosen before the first existed.
//
// So the claim under test is the whole loop and not the writer alone — read a
// revision through the read surface, send it back through the command, and be
// refused rather than merged when the row has moved on. The refusal the caller
// meets is `VERSION_STALE`, the code the register already holds for a write
// against a revision that is no longer current, and the stored value is what
// the winner wrote.
//
// `expectedRevision` is optional here and stays optional. A caller that has
// never learnt to send one still writes, because the four contracts that name
// these settings predate the column and a required field would have made every
// one of them a refusal.

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
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('settings revision: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('the settings commands write against a revision', () => {
  let db: FreshDatabase;
  let alpha: string;
  /** Reads settings and manages them: the only actor these cases need. */
  let mia: Member;

  /** The row itself, read the way the records module reads it. */
  const band = async () =>
    await db.app.withBusiness(
      alpha,
      async (tx) => await readBusinessSetting(tx, 'four_eyes_threshold'),
    );

  const setBand = async (value: number | null, expectedRevision?: number) =>
    await executeCommand(db.app, alpha, mia.presented, 'api', {
      command: 'settings.set_four_eyes_threshold',
      operationId: `band-${randomUUID()}`,
      value,
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    });

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'l3rev' });
    alpha = await insertBusiness(db.app, 'alpha');
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
  }, 60_000);

  afterAll(async () => await db?.drop());

  it('applies a write that names no revision at all, and hands the new one back', async () => {
    const before = await band();
    const result = await setBand(610);
    expect(isCommandRefusal(result)).toBe(false);
    if (isCommandRefusal(result)) return;
    expect(result.revision).toBe((before?.revision ?? 0) + 1);
    expect(result.detail['revision']).toBe(result.revision);
    expect((await band())?.value).toBe(610);
  });

  it('applies a write that names the revision the row is actually at', async () => {
    const before = await band();
    const result = await setBand(620, before?.revision);
    expect(isCommandRefusal(result)).toBe(false);
    if (isCommandRefusal(result)) return;
    expect(result.revision).toBe((before?.revision ?? 0) + 1);
    expect((await band())?.value).toBe(620);
  });

  it('refuses a write against a revision the row has moved past, leaving the value alone', async () => {
    const written = await setBand(630);
    expect(isCommandRefusal(written)).toBe(false);
    const current = await band();
    const stale = (current?.revision ?? 1) - 1;

    const refusal = await setBand(999, stale);
    expect(isCommandRefusal(refusal)).toBe(true);
    if (!isCommandRefusal(refusal)) return;
    expect(refusal.code).toBe('VERSION_STALE');
    expect(refusal.names).toContain(`revision=${current?.revision}`);

    // The whole point of the refusal: the loser's value never reached the row.
    const after = await band();
    expect(after?.value).toBe(630);
    expect(after?.revision).toBe(current?.revision);
  });

  it('refuses a stale sign-off write the same way', async () => {
    const applied = await executeCommand(db.app, alpha, mia.presented, 'api', {
      command: 'settings.set_client_sign_off',
      operationId: `sign-${randomUUID()}`,
      value: true,
    });
    expect(isCommandRefusal(applied)).toBe(false);
    const current = await db.app.withBusiness(
      alpha,
      async (tx) => await readBusinessSetting(tx, 'client_sign_off_required'),
    );

    const refusal = await executeCommand(db.app, alpha, mia.presented, 'api', {
      command: 'settings.set_client_sign_off',
      operationId: `sign-${randomUUID()}`,
      value: false,
      expectedRevision: (current?.revision ?? 1) - 1,
    });
    expect(isCommandRefusal(refusal) ? refusal.code : '').toBe('VERSION_STALE');
    const after = await db.app.withBusiness(
      alpha,
      async (tx) => await readBusinessSetting(tx, 'client_sign_off_required'),
    );
    expect(after?.value).toBe(true);
  });

  it('carries a numeric revision on every settings.read row', async () => {
    const result = await executeRead(db.app, alpha, mia.presented, { read: 'settings.read' });
    expect('settings' in result).toBe(true);
    if (!('settings' in result)) return;
    expect(result.settings.length).toBeGreaterThan(0);
    for (const setting of result.settings) {
      expect(typeof setting.revision).toBe('number');
    }
    const read = result.settings.find((setting) => setting.key === 'four_eyes_threshold');
    expect(read?.revision).toBe((await band())?.revision);
  });
});
