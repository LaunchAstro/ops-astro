// SPDX-License-Identifier: AGPL-3.0-only
//
// C59: the second factor at sign-in, and the one money step-up.
//
// Three facts are under test. The sign-in adapter passes the provider's
// assurance through beside `sub` and nothing else: the level (`aal`), when the
// session's first sign-in happened and when its second factor was verified,
// read from the verified token's `amr`, which a refresh carries unchanged. A
// person who has a verified factor is refused on every call made without it.
// And a command whose key is in the money set needs a sign-in with the second
// factor inside the step-up window, judged once, inside the grant check, behind
// a setting that is on by default and that only `settings:manage` switches.

import { randomUUID } from 'node:crypto';
import { sign } from 'hono/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  isMoneyKey,
  judgeStepUp,
  MONEY_STEP_UP_SETTING,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import {
  NO_ASSURANCE,
  type Assurance,
} from '../../packages/core-records/src/identity/verified-subject.ts';
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
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
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

const SECRET = 'c59-test-secret-not-any-running-deployment';
const ISSUER = 'http://127.0.0.1:54391';
const verify = createSupabaseVerifier({ secret: SECRET, issuer: ISSUER });

/** A request as the adapter sees one: only the authorisation header is read. */
function requestWith(token: string) {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
  } as unknown as Parameters<typeof verify>[0];
}

async function tokenWith(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await sign(
    { sub: 'sub-c59', aud: 'authenticated', iss: ISSUER, exp: now + 600, iat: now, ...claims },
    SECRET,
    'HS256',
  );
}

describe('C59 the adapter passes the assurance through beside sub', () => {
  it('C59 aal passes through beside sub: aal2 with its factor time and its sign-in time', async () => {
    const token = await tokenWith({
      aal: 'aal2',
      amr: [
        { method: 'totp', timestamp: 1_900_000_100 },
        { method: 'password', timestamp: 1_900_000_000 },
      ],
    });
    expect(await verify(requestWith(token))).toEqual({
      provider: 'supabase',
      subject: 'sub-c59',
      assurance: { level: 'aal2', signedInAt: 1_900_000_000, factorAt: 1_900_000_100 },
    });
  });

  it('C59 aal passes through beside sub: aal1 carries its sign-in time and no factor time', async () => {
    const token = await tokenWith({
      aal: 'aal1',
      amr: [{ method: 'password', timestamp: 1_900_000_000 }],
    });
    expect(await verify(requestWith(token))).toMatchObject({
      assurance: { level: 'aal1', signedInAt: 1_900_000_000, factorAt: null },
    });
  });

  it('C59 refresh keeps factor time: a refreshed token with a newer iat keeps the factor time', async () => {
    const amr = [
      { method: 'totp', timestamp: 1_900_000_100 },
      { method: 'password', timestamp: 1_900_000_000 },
    ];
    const first = await verify(requestWith(await tokenWith({ aal: 'aal2', amr })));
    const refreshed = await verify(
      requestWith(await tokenWith({ aal: 'aal2', amr, iat: Math.floor(Date.now() / 1000) + 5 })),
    );
    expect(first).toMatchObject({ assurance: { factorAt: 1_900_000_100 } });
    expect(refreshed).toEqual(first);
  });

  // Every malformed shape is the lowest assurance, never a guess: a claim the
  // adapter cannot read grants nothing a missing claim would not.
  it.each([
    ['an unknown level', { aal: 'aal3', amr: [{ method: 'totp', timestamp: 1_900_000_100 }] }],
    ['aal2 with no factor entry', { aal: 'aal2', amr: [{ method: 'password', timestamp: 1 }] }],
    ['amr not a list', { aal: 'aal2', amr: 'totp' }],
    [
      'a factor time that is text',
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: '1900000100' }] },
    ],
    ['a factor time that is not whole', { aal: 'aal2', amr: [{ method: 'totp', timestamp: 1.5 }] }],
    ['no aal at all', { amr: [{ method: 'totp', timestamp: 1_900_000_100 }] }],
  ])(
    'C59 aal passes through beside sub: %s reads as aal1 with no factor time',
    async (_, claims) => {
      const verified = await verify(requestWith(await tokenWith(claims)));
      expect(verified).toMatchObject({ assurance: { level: 'aal1', factorAt: null } });
    },
  );

  it('C59 aal passes through beside sub: a token claiming aal2 under the wrong secret is nobody', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await sign(
      { sub: 'sub-c59', aud: 'authenticated', iss: ISSUER, exp: now + 600, aal: 'aal2' },
      'not-the-secret',
      'HS256',
    );
    expect(await verify(requestWith(forged))).toBeUndefined();
  });
});

const teamMember = (assurance: Assurance) => ({ roleKey: 'member', assurance });
const clientPerson = (assurance: Assurance) => ({ roleKey: null, assurance });

describe('C59 step-up boundary, as a rule', () => {
  const NOW = 2_000_000_000;

  it('C59 step-up boundary: the window is sixty minutes, set in one place', () => {
    expect(STEP_UP_WINDOW_SECONDS).toBe(60 * 60);
  });

  it('C59 step-up boundary: a team member one second inside the window is accepted, one past refused', () => {
    const inside = NOW - STEP_UP_WINDOW_SECONDS + 1;
    const past = NOW - STEP_UP_WINDOW_SECONDS - 1;
    expect(
      judgeStepUp(teamMember({ level: 'aal2', signedInAt: inside, factorAt: inside }), NOW),
    ).toBe('fresh');
    expect(judgeStepUp(teamMember({ level: 'aal2', signedInAt: past, factorAt: past }), NOW)).toBe(
      'stale',
    );
  });

  it('C59 step-up boundary: a team member needs the second factor, not a fresh password', () => {
    expect(
      judgeStepUp(teamMember({ level: 'aal1', signedInAt: NOW - 5, factorAt: null }), NOW),
    ).toBe('stale');
    expect(judgeStepUp(teamMember(NO_ASSURANCE), NOW)).toBe('stale');
  });

  it('C59 step-up boundary: a client, who may have no factor, signs in afresh', () => {
    const inside = NOW - STEP_UP_WINDOW_SECONDS + 1;
    const past = NOW - STEP_UP_WINDOW_SECONDS - 1;
    expect(
      judgeStepUp(clientPerson({ level: 'aal1', signedInAt: inside, factorAt: null }), NOW),
    ).toBe('fresh');
    expect(
      judgeStepUp(clientPerson({ level: 'aal1', signedInAt: past, factorAt: null }), NOW),
    ).toBe('stale');
    expect(judgeStepUp(clientPerson(NO_ASSURANCE), NOW)).toBe('stale');
  });

  it('C59 step-up boundary: a factor time in the future is refused, never read as fresh', () => {
    const later = NOW + 600;
    expect(
      judgeStepUp(teamMember({ level: 'aal2', signedInAt: later, factorAt: later }), NOW),
    ).toBe('stale');
  });

  it('C59 step-up boundary: the money set is every billing key, offer:decide, mandate:manage and spend:decide', () => {
    for (const action of [
      'read',
      'comment',
      'write',
      'assign',
      'decide',
      'share',
      'manage',
    ] as const) {
      expect(isMoneyKey('billing', action)).toBe(true);
    }
    expect(isMoneyKey('offer', 'decide')).toBe(true);
    expect(isMoneyKey('mandate', 'manage')).toBe(true);
    expect(isMoneyKey('spend', 'decide')).toBe(true);
    expect(isMoneyKey('offer', 'write')).toBe(false);
    expect(isMoneyKey('spend', 'read')).toBe(false);
    expect(isMoneyKey('task', 'decide')).toBe(false);
    expect(isMoneyKey('settings', 'manage')).toBe(false);
  });
});

/** A fixture member's verified subject, carrying the assurance a sign-in gave it. */
const signedIn = (person: Member, assurance: Assurance) => ({ ...person.presented, assurance });

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('C59 second factor: DATABASE_URL is unset, so the database cases did not run.');
}

describe.skipIf(serverUrl === undefined)('C59 on the command path', () => {
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
