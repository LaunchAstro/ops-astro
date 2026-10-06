// SPDX-License-Identifier: AGPL-3.0-only
//
// Switching the money step-up off asks the step-up itself (C59), judged on the
// database clock inside the serving transaction. The instant it is judged at
// must be read after the transaction's lock waits, not its start: a sign-in
// whose second factor ages out of the window while the switch waits at
// sign-in is stale when the switch goes on.
//
// The owner's person row is held `for update` on another connection, so the
// switch's sign-in record waits on it. Its factor is one second inside the
// window when its transaction begins; the holder lets go once the database
// clock has carried it past. The switch is refused `STEP_UP_REQUIRED` and the
// protection stays on.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  MONEY_STEP_UP_SETTING,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { blockedBefore, holdRow, instantOf, waitPast } from '../support/lock-wait-race.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('the money step-up across a sign-in lock wait', () => {
  let db: FreshDatabase;
  let business: string;
  let owner: Member;

  beforeAll(async () => {
    db = await createFreshDatabase({ part: 'stepupwait' });
    business = await insertBusiness(db.app, 'step-up-wait');
    owner = await enrol(db.app, business, 'owner');
    await installSpine(db.app, business);
    await db.app.withBusiness(business, async (tx) => {
      await installBusinessSettings(tx);
      await grantTo(tx, owner, 'manage', WHOLE_BUSINESS, false, 'settings');
    });
  }, 120_000);

  afterAll(async () => await db?.drop());

  it('a money protection switch waiting at sign-in cannot use a step-up that expired during the wait', async () => {
    const clock = await db.admin.execute<{ readonly now: number }>(
      'select floor(extract(epoch from clock_timestamp()))::float8 as now',
    );
    const now = Number(clock[0]?.now);
    // One second inside the window now; stale from `factorAt + window + 1`.
    const factorAt = now - STEP_UP_WINDOW_SECONDS + 1;
    const stale = await instantOf(db, 'select to_timestamp($1::float8)::text as at', [
      factorAt + STEP_UP_WINDOW_SECONDS + 1,
    ]);
    const held = await holdRow(db, 'select id from public.people where id = $1 for update', [
      owner.personId,
    ]);
    const switching = executeCommand(
      db.app,
      business,
      { ...owner.presented, assurance: { level: 'aal2', signedInAt: now, factorAt } },
      'api',
      { command: 'settings.set_money_step_up', operationId: randomUUID(), value: false },
    );
    let startedFresh = false;
    try {
      startedFresh = await blockedBefore(db, held, stale);
      await waitPast(db, stale);
    } finally {
      await held.letGo();
    }
    const answer = await switching;
    const setting = await db.app.withBusiness(
      business,
      async (tx) => await readBusinessSetting(tx, MONEY_STEP_UP_SETTING),
    );
    expect({
      startedFresh,
      code: isCommandRefusal(answer) ? answer.code : 'applied',
      protection: setting?.value,
    }).toEqual({ startedFresh: true, code: 'STEP_UP_REQUIRED', protection: true });
  }, 30_000);
});
