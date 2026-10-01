// SPDX-License-Identifier: AGPL-3.0-only
//
// `access.read` marks the permissions the money step-up (C59) stands in front
// of, per key: a permission previewed as usable now carries `stepUp` exactly
// when the command path would refuse a stale sign-in `STEP_UP_REQUIRED` on that
// key, which is the money set while the business setting is on, and an absent
// setting reads as on. Switching the money step-up off is asked on its own, by
// command and not by key, so `settings:manage` stays unmarked.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import {
  MONEY_STEP_UP_SETTING,
  refuseStaleMoneyStep,
} from '../../packages/core-records/src/authority/step-up.ts';
import { NO_ASSURANCE } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  installBusinessSettings,
  writeBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import type { AccessPermission } from '../../packages/core-wire/src/index.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let owner: Member;
let ada: Member;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'access_step_up' });
  alpha = await insertBusiness(db.app, 'access-step-up');
  owner = await enrol(db.app, alpha, 'Olive');
  ada = await enrol(db.app, alpha, 'Ada');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, owner, 'manage', WHOLE_BUSINESS, false, 'access');
    await grantTo(tx, ada, 'decide', WHOLE_BUSINESS, false, 'billing');
    await grantTo(tx, ada, 'read', WHOLE_BUSINESS, false, 'task');
  });
}, 180_000);

afterAll(async () => {
  if (serverUrl !== undefined) await db.drop();
});

/** A previewed permission, with the step-up mark the read gives it. */
type Previewed = AccessPermission & { readonly stepUp?: boolean };

async function adaPreview(): Promise<readonly Previewed[]> {
  const answer = await executeRead(db.app, alpha, owner.presented, { read: 'access.read' });
  if (!('team' in answer)) throw new Error(`access.read refused ${JSON.stringify(answer)}`);
  return answer.team.find((person) => person.personId === ada.personId)?.permissions ?? [];
}

/** What the command path says of each previewed key for a sign-in with no factor. */
async function commandPathAsks(permissions: readonly Previewed[]): Promise<boolean[]> {
  return await db.app.withBusiness(
    alpha,
    async (tx) =>
      await Promise.all(
        permissions.map(
          async (permission) =>
            (
              await refuseStaleMoneyStep(
                tx,
                { roleKey: 'member', assurance: NO_ASSURANCE },
                permission,
              )
            )?.code === 'STEP_UP_REQUIRED',
        ),
      ),
  );
}

const marks = (permissions: readonly Previewed[]) =>
  Object.fromEntries(
    permissions.map((each) => [`${each.collection}:${each.action}`, each.stepUp] as const),
  );

describe.skipIf(serverUrl === undefined)('Settings ▸ Access money step-up preview', () => {
  it('marks a billing permission as needing a recent second factor when no setting is installed', async () => {
    const shown = await adaPreview();
    expect(marks(shown)).toStrictEqual({ 'billing:decide': true, 'task:read': false });
    expect(shown.map((each) => each.stepUp)).toStrictEqual(await commandPathAsks(shown));
  });

  it('drops the mark once the business switches the money step-up off', async () => {
    await db.app.withBusiness(alpha, async (tx) => {
      await installBusinessSettings(tx);
      const written = await writeBusinessSetting(tx, {
        key: MONEY_STEP_UP_SETTING,
        value: false,
        owningOperation: 'settings.set_money_step_up',
      });
      if (written === undefined || 'refused' in written) throw new Error('setting not written');
    });
    const shown = await adaPreview();
    expect(marks(shown)).toStrictEqual({ 'billing:decide': false, 'task:read': false });
    expect(shown.map((each) => each.stepUp)).toStrictEqual(await commandPathAsks(shown));
  });
});
