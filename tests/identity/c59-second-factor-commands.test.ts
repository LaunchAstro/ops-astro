// SPDX-License-Identifier: AGPL-3.0-only
//
// C59 on the command path: the money step-up judged inside the grant check,
// its setting (on by default, switched by `settings:manage` alone, audited,
// per business), and the second factor required once enrolled. The adapter
// and the rule are in `c59-second-factor.test.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MONEY_STEP_UP_SETTING,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import { type Assurance } from '../../packages/core-records/src/identity/verified-subject.ts';
import {
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/identity/second-factor.ts';
import { withSession } from '../../packages/core-records/src/identity/login-resolution.ts';
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
import { prepareCommand } from '../../packages/core-commands/src/commands/prepare.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { declarationOf, type CommandDeclaration } from '../../packages/core-wire/src/surface.ts';
import { insertBusiness } from './fixture.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';

/** A fixture member's verified subject, carrying the assurance a sign-in gave it. */
const signedIn = (person: Member, assurance: Assurance) => ({ ...person.presented, assurance });

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('C59 second factor: DATABASE_URL is unset, so the database cases did not run.');
}

let db: FreshDatabase;
let alpha: string;
let bravo: string;

/** Holds billing:decide and settings:manage in alpha: the administrator. */
let ava: Member;

/** Holds billing:decide and settings:read in alpha, not settings:manage. */
let milo: Member;

/** Bravo's administrator. */
let bea: Member;

/**
 * A money command as the envelope sees one. No command on this head holds a
 * money key (wave 0's `budget.*` are `billing:decide` and land later), so the
 * settings command's own row is asked about `billing:decide` and run through
 * the real preparation, grant check and all. The catalogue-wide sweep (S0-5)
 * covers every real money command from the day it exists.
 */
const MONEY: CommandDeclaration = {
  ...declarationOf('settings.set_client_sign_off'),
  collection: 'billing',
  action: 'decide',
};

const dbNow = async (): Promise<number> =>
  await db.app.withBusiness(alpha, async (tx) => {
    const rows = await tx.query<{ readonly now: number }>(
      'select floor(extract(epoch from now()))::float8 as now',
    );
    return rows[0]?.now ?? 0;
  });

/** Prepare the money command as `member` would present it, and say how it ended. */
const prepareMoney = async (member: Member, assurance: Assurance, businessId = alpha) =>
  await withSession(db.app, businessId, signedIn(member, assurance), async (tx, session) => {
    const prepared = await prepareCommand(
      tx,
      session,
      'api',
      { command: 'settings.set_client_sign_off', operationId: `m-${randomUUID()}`, value: true },
      MONEY,
    );
    return 'refusal' in prepared ? prepared.refusal.code : 'prepared';
  });

const setStepUp = async (member: Member, value: unknown, businessId = alpha) =>
  await executeCommand(db.app, businessId, member.presented, 'api', {
    command: 'settings.set_money_step_up',
    operationId: `step-${randomUUID()}`,
    value,
  });

const stepUpValue = async (businessId: string) =>
  await db.app.withBusiness(
    businessId,
    async (tx) => (await readBusinessSetting(tx, MONEY_STEP_UP_SETTING))?.value,
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  db = await createFreshDatabase({ part: 'c59' });
  alpha = await insertBusiness(db.app, 'alpha');
  bravo = await insertBusiness(db.app, 'bravo');
  for (const business of [alpha, bravo]) {
    // Sequential: two installs, one fixture, and nothing gained by racing them.
    // oxlint-disable-next-line no-await-in-loop
    await installSpine(db.app, business);
    // oxlint-disable-next-line no-await-in-loop
    await db.app.withBusiness(business, async (tx) => await installBusinessSettings(tx));
  }
  ava = await enrol(db.app, alpha, 'ava');
  milo = await enrol(db.app, alpha, 'milo');
  bea = await enrol(db.app, bravo, 'bea');
  const WHOLE = { kind: 'business', id: null } as const;
  await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, ava, 'read');
    await grantTo(tx, ava, 'decide', WHOLE, false, 'billing');
    await grantTo(tx, ava, 'read', WHOLE, false, 'settings');
    await grantTo(tx, ava, 'manage', WHOLE, false, 'settings');
    await grantTo(tx, milo, 'read');
    await grantTo(tx, milo, 'decide', WHOLE, false, 'billing');
    await grantTo(tx, milo, 'read', WHOLE, false, 'settings');
  });
  await db.app.withBusiness(bravo, async (tx) => {
    await grantTo(tx, bea, 'read', WHOLE, false, 'settings');
    await grantTo(tx, bea, 'manage', WHOLE, false, 'settings');
  });
}, 60_000);

afterAll(async () => await db?.drop());

describe.skipIf(serverUrl === undefined)('C59 on the command path', () => {
  it('C59 money step-up toggle: the setting is on by default', async () => {
    expect(await stepUpValue(alpha)).toBe(true);
  });

  it('C59 step-up boundary: through the grant check, one second inside is accepted and one past refused', async () => {
    const now = await dbNow();
    const inside = now - STEP_UP_WINDOW_SECONDS + 1;
    const past = now - STEP_UP_WINDOW_SECONDS - 1;
    expect(await prepareMoney(ava, { level: 'aal2', signedInAt: inside, factorAt: inside })).toBe(
      'prepared',
    );
    expect(await prepareMoney(ava, { level: 'aal2', signedInAt: past, factorAt: past })).toBe(
      'STEP_UP_REQUIRED',
    );
  });

  it('C59 step-up boundary: the grant check comes first, so no grant is refused as no grant', async () => {
    const now = await dbNow();
    // Bea holds nothing on billing in alpha's sense: she is not in alpha at all,
    // and in bravo she holds no billing grant. A fresh factor gives her nothing.
    expect(await prepareMoney(bea, { level: 'aal2', signedInAt: now, factorAt: now }, bravo)).toBe(
      'SCOPE_NOT_GRANTED',
    );
  });

  it('C59 money step-up toggle: switched off, the stale sign-in runs; on again, it is refused', async () => {
    const now = await dbNow();
    const stale: Assurance = { level: 'aal1', signedInAt: now - 7200, factorAt: null };
    const fresh: Assurance = { level: 'aal2', signedInAt: now, factorAt: now };
    expect(await prepareMoney(ava, stale)).toBe('STEP_UP_REQUIRED');
    expect(await prepareMoney(ava, fresh)).toBe('prepared');

    const off = await setStepUp(ava, false);
    expect(isCommandRefusal(off)).toBe(false);
    expect(await stepUpValue(alpha)).toBe(false);
    expect(await prepareMoney(ava, stale)).toBe('prepared');

    const on = await setStepUp(ava, true);
    expect(isCommandRefusal(on)).toBe(false);
    expect(await prepareMoney(ava, stale)).toBe('STEP_UP_REQUIRED');
    expect(await prepareMoney(ava, fresh)).toBe('prepared');
  });
});

describe.skipIf(serverUrl === undefined)('C59 on the command path', () => {
  it('C59 toggle admin only: a person without settings:manage is refused and the setting stays', async () => {
    const before = await stepUpValue(alpha);
    const refused = await setStepUp(milo, !before);
    expect(isCommandRefusal(refused)).toBe(true);
    if (!isCommandRefusal(refused)) return;
    expect(refused.code).toBe('SCOPE_NOT_GRANTED');
    expect(await stepUpValue(alpha)).toBe(before);
  });

  it('C59 toggle admin only: a value that is not true or false is refused', async () => {
    const refused = await setStepUp(ava, 'off');
    expect(isCommandRefusal(refused)).toBe(true);
    if (!isCommandRefusal(refused)) return;
    expect(refused.code).toBe('FIELD_VALUE_INVALID');
  });

  it('C59 toggle audited: every switch is read back from the audit chain, and the chain holds', async () => {
    const first = await setStepUp(ava, false);
    const second = await setStepUp(ava, true);
    const refused = await setStepUp(milo, false);
    expect(isCommandRefusal(first) || isCommandRefusal(second)).toBe(false);
    expect(isCommandRefusal(refused)).toBe(true);
    await db.app.withBusiness(alpha, async (tx) => {
      const events = (await readAuditEvents(tx)).filter(
        (event) => event.command === 'settings.set_money_step_up',
      );
      const applied = events.filter((event) => event.outcome === 'applied');
      expect(applied.map((event) => event.actor_id)).toContain(ava.actorId);
      expect(applied.length).toBeGreaterThanOrEqual(2);
      expect(
        events.some((event) => event.outcome === 'refused' && event.actor_id === milo.actorId),
      ).toBe(true);
      const chain = await verifyAuditChain(tx);
      expect(chain.intact).toBe(true);
    });
  });

  it('C59 isolation: switching the step-up in bravo leaves alpha alone', async () => {
    const alphaBefore = await stepUpValue(alpha);
    const switched = await setStepUp(bea, false, bravo);
    expect(isCommandRefusal(switched)).toBe(false);
    expect(await stepUpValue(bravo)).toBe(false);
    expect(await stepUpValue(alpha)).toBe(alphaBefore);
    // And alpha's administrator cannot reach bravo's row: in bravo she is nobody.
    const across = await setStepUp(ava, true, bravo);
    expect(isCommandRefusal(across)).toBe(true);
    expect(await stepUpValue(bravo)).toBe(false);
  });
});

describe.skipIf(serverUrl === undefined)('C59 on the command path', () => {
  it('C59 second factor required once enrolled: aal1 is refused, aal2 is served', async () => {
    const now = await dbNow();
    const read = async (assurance: Assurance) =>
      await executeRead(db.app, alpha, signedIn(milo, assurance), { read: 'settings.read' });

    // Before any factor, a password sign-in is enough to read.
    expect(isCommandRefusal(await read({ level: 'aal1', signedInAt: now, factorAt: null }))).toBe(
      false,
    );

    await db.app.withBusiness(alpha, async (tx) => {
      const enrolled = await recordFactorEnrolled(tx, {
        personId: milo.personId,
        provider: 'supabase',
        providerFactorId: `factor-${randomUUID()}`,
      });
      await recordFactorVerified(tx, { personId: milo.personId, factorId: enrolled.id });
    });

    const refused = await read({ level: 'aal1', signedInAt: now, factorAt: null });
    expect(isCommandRefusal(refused)).toBe(true);
    if (isCommandRefusal(refused)) expect(refused.code).toBe('AUTH_SECOND_FACTOR_REQUIRED');
    expect(isCommandRefusal(await read({ level: 'aal2', signedInAt: now, factorAt: now }))).toBe(
      false,
    );

    // Ava has no factor: her aal1 sign-in still reads, so one person's factor
    // is not another's requirement.
    const avaRead = await executeRead(
      db.app,
      alpha,
      signedIn(ava, { level: 'aal1', signedInAt: now, factorAt: null }),
      { read: 'settings.read' },
    );
    expect(isCommandRefusal(avaRead)).toBe(false);
  });
});
