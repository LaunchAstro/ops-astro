// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-2-11 recent sign-in: changing the four-eyes threshold is a money action
// (`spend:decide`, owner line 71), so C59's one step-up judges it at the
// sixty-minute boundary, `settings:manage` alone does not reach it, and no
// agent does. C59's own rule and setting are in `c59-second-factor*.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isMoneyKey,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import { type Assurance } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  installBusinessSettings,
  readBusinessSetting,
} from '../../packages/core-records/src/records/business-settings.ts';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { declarationOf } from '../../packages/core-wire/src/surface.ts';
import { insertBusiness } from './fixture.ts';
import { enrol, grantTo, installSpine, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { agentWorld, codeOf } from '../commands/agent-fixture.ts';

const THRESHOLD = 'settings.set_four_eyes_threshold';
const serverUrl = databaseUrlFromEnvironment();

let db: FreshDatabase;
let alpha: string;
let bravo: string;
/** Holds spend:decide in alpha. */
let ava: Member;
/** Holds settings:manage in alpha, not spend:decide. */
let milo: Member;
/** Holds spend:decide in bravo. */
let bea: Member;

const dbNow = async (): Promise<number> =>
  await db.app.withBusiness(alpha, async (tx) => {
    const rows = await tx.query<{ readonly now: number }>(
      'select floor(extract(epoch from now()))::float8 as now',
    );
    return rows[0]?.now ?? 0;
  });

/** A sign-in whose second factor was given at `t`. */
const at = (t: number): Assurance => ({ level: 'aal2', signedInAt: t, factorAt: t });

const fresh = async (): Promise<Assurance> => at(await dbNow());

/** Set the threshold as `member`, signed in as `assurance`; the refusal code or 'applied'. */
const setThreshold = async (
  member: Member,
  assurance: Assurance,
  value: number,
  businessId = alpha,
): Promise<string> => {
  const outcome = await executeCommand(
    db.app,
    businessId,
    { ...member.presented, assurance },
    'api',
    { command: THRESHOLD, operationId: `fe-${randomUUID()}`, value },
  );
  return isCommandRefusal(outcome) ? outcome.code : 'applied';
};

const threshold = async (businessId = alpha): Promise<unknown> =>
  await db.app.withBusiness(
    businessId,
    async (tx) => (await readBusinessSetting(tx, 'four_eyes_threshold'))?.value,
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'mp211su' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  for (const business of [alpha, bravo]) {
    // oxlint-disable-next-line no-await-in-loop
    await installSpine(db.app, business);
    // oxlint-disable-next-line no-await-in-loop
    await db.app.withBusiness(business, async (tx) => await installBusinessSettings(tx));
  }
  ava = await enrol(db.app, alpha, 'ava');
  milo = await enrol(db.app, alpha, 'milo');
  bea = await enrol(db.app, bravo, 'bea');
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ava, 'decide', WHOLE_BUSINESS, false, 'spend');
    await grantTo(tx, milo, 'manage', WHOLE_BUSINESS, false, 'settings');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bea, 'decide', WHOLE_BUSINESS, false, 'spend');
  });
}, 60_000);

afterAll(async () => await db?.drop());

describe('MP-2-11 recent sign-in, the declaration', () => {
  it('MP-2-11 recent sign-in: the four-eyes threshold is spend:decide, a money key no agent holds', () => {
    const row = declarationOf(THRESHOLD);
    expect([row.collection, row.action, row.agent]).toEqual(['spend', 'decide', 'never']);
    expect(isMoneyKey(row.collection, row.action)).toBe(true);
  });
});

describe.skipIf(serverUrl === undefined)('MP-2-11 recent sign-in on the command path', () => {
  it('MP-2-11 recent sign-in: one second inside sixty minutes applies; one past, or no factor, writes nothing', async () => {
    const now = await dbNow();
    const inside = now - STEP_UP_WINDOW_SECONDS + 1;
    const past = now - STEP_UP_WINDOW_SECONDS - 1;
    expect(await setThreshold(ava, at(inside), 900)).toBe('applied');
    expect(await threshold()).toBe(900);
    expect(await setThreshold(ava, at(past), 1200)).toBe('STEP_UP_REQUIRED');
    const noFactor: Assurance = { level: 'aal1', signedInAt: now, factorAt: null };
    expect(await setThreshold(ava, noFactor, 1200)).toBe('STEP_UP_REQUIRED');
    expect(await threshold()).toBe(900);
    await db.app.withBusiness(alpha, async (tx) => {
      const events = (await readAuditEvents(tx)).filter((event) => event.command === THRESHOLD);
      expect(events.map((event) => event.outcome)).toEqual(['applied', 'refused', 'refused']);
      expect((await verifyAuditChain(tx)).intact).toBe(true);
    });
  });

  it('MP-2-11 recent sign-in: settings:manage alone is refused the threshold, and keeps client sign-off', async () => {
    const before = await threshold();
    expect(await setThreshold(milo, await fresh(), 50)).toBe('SCOPE_NOT_GRANTED');
    expect(await threshold()).toBe(before);
    const signOff = await executeCommand(db.app, alpha, milo.presented, 'api', {
      command: 'settings.set_client_sign_off',
      operationId: `so-${randomUUID()}`,
      value: false,
    });
    expect(isCommandRefusal(signOff)).toBe(false);
  });

  it('MP-2-11 recent sign-in: another business is its own, both ways', async () => {
    const alphaBefore = await threshold();
    expect(await setThreshold(bea, await fresh(), 2500, bravo)).toBe('applied');
    expect(await threshold(bravo)).toBe(2500);
    expect(await threshold()).toBe(alphaBefore);
    expect(await setThreshold(ava, await fresh(), 1, bravo)).not.toBe('applied');
    expect(await threshold(bravo)).toBe(2500);
  });
});

describe.skipIf(serverUrl === undefined)('MP-2-11 recent sign-in, an agent', () => {
  it('MP-2-11 recent sign-in: an agent under a live delegation from a spend:decide holder is refused', async () => {
    const world = await agentWorld('mp211agent', 'mp211agent');
    try {
      await world.db.app.withBusiness(
        world.business,
        async (tx) => await installBusinessSettings(tx),
      );
      const owner = await world.decider('owner');
      await world.db.app.withBusiness(world.business, async (tx) => {
        await grantTo(tx, owner, 'decide', WHOLE_BUSINESS, true, 'spend');
      });
      const picked = await world.pickUp(owner, 'mp-2-11 agent work');
      const body = { command: THRESHOLD, operationId: `fe-agent-${randomUUID()}`, value: 7 };
      expect(codeOf(await world.asAgent(body, picked.credential))).toBe(
        'DELEGATION_EXCLUDES_OPERATION',
      );
      const value = await world.db.app.withBusiness(
        world.business,
        async (tx) => (await readBusinessSetting(tx, 'four_eyes_threshold'))?.value,
      );
      expect(value).not.toBe(7);
    } finally {
      await world.drop();
    }
  }, 60_000);
});
