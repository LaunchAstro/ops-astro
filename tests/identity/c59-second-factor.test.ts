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
//
// The adapter and the step-up rule need no database and are here. The
// command path is in `c59-second-factor-commands.test.ts`, and the setting
// being a person's alone in `c59-step-up-person.test.ts`.

import { describe, expect, it } from 'vitest';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  isMoneyKey,
  judgeStepUp,
  STEP_UP_WINDOW_SECONDS,
} from '../../packages/core-records/src/authority/step-up.ts';
import {
  NO_ASSURANCE,
  type Assurance,
} from '../../packages/core-records/src/identity/verified-subject.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';
import { signBearer, signForged, testSignIn } from '../support/sign-in.ts';

const ISSUER = 'http://127.0.0.1:54391';
// The server's clock a little after the fixed sign-in times below, so each is
// inside C58's 12-hour limit whatever the real date.
const verify = createSupabaseVerifier({ ...testSignIn(ISSUER), now: () => 1_900_000_200 });
const SIGNED_IN = { method: 'password', timestamp: 1_900_000_000 };

/** A request as the adapter sees one: only the authorisation header is read. */
function requestWith(token: string) {
  return {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined,
  } as unknown as Parameters<typeof verify>[0];
}

async function tokenWith(claims: Record<string, unknown>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return await signBearer({
    sub: 'sub-c59',
    aud: 'authenticated',
    iss: ISSUER,
    exp: now + 600,
    iat: now,
    ...claims,
  });
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
    // `iat` moves on every refresh; hono refuses one in the future, so the
    // first token is the older one.
    const now = Math.floor(Date.now() / 1000);
    const first = await verify(requestWith(await tokenWith({ aal: 'aal2', amr, iat: now - 1800 })));
    const refreshed = await verify(requestWith(await tokenWith({ aal: 'aal2', amr, iat: now })));
    expect(first).toMatchObject({ assurance: { factorAt: 1_900_000_100 } });
    expect(refreshed).toEqual(first);
  });
});

describe('C59 the adapter passes the assurance through beside sub', () => {
  // Every malformed shape is the lowest assurance, never a guess: a claim the
  // adapter cannot read grants nothing a missing claim would not.
  it.each([
    [
      'an unknown level',
      { aal: 'aal3', amr: [{ method: 'totp', timestamp: 1_900_000_100 }, SIGNED_IN] },
    ],
    ['aal2 with no factor entry', { aal: 'aal2', amr: [SIGNED_IN] }],
    [
      'a factor time that is text',
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: '1900000100' }, SIGNED_IN] },
    ],
    [
      'a factor time that is not whole',
      { aal: 'aal2', amr: [{ method: 'totp', timestamp: 1.5 }, SIGNED_IN] },
    ],
    ['no aal at all', { amr: [{ method: 'totp', timestamp: 1_900_000_100 }, SIGNED_IN] }],
  ])(
    'C59 aal passes through beside sub: %s reads as aal1 with no factor time',
    async (_, claims) => {
      const verified = await verify(requestWith(await tokenWith(claims)));
      expect(verified).toMatchObject({ assurance: { level: 'aal1', factorAt: null } });
    },
  );

  // An `amr` that is not a list carries no first sign-in either, so the
  // session cannot be shown to be inside its 12 hours (C58): it is expired.
  it('C59 aal passes through beside sub: amr not a list is no first sign-in, so an ended session', async () => {
    expect(await verify(requestWith(await tokenWith({ aal: 'aal2', amr: 'totp' })))).toBe(
      'expired',
    );
  });

  it('C59 aal passes through beside sub: a token claiming aal2 under a key the set does not hold is nobody', async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await signForged({
      sub: 'sub-c59',
      aud: 'authenticated',
      iss: ISSUER,
      exp: now + 600,
      aal: 'aal2',
    });
    expect(await verify(requestWith(forged))).toBeUndefined();
  });
});

const teamMember = (assurance: Assurance) => ({ roleKey: 'member', assurance });
const clientPerson = (assurance: Assurance) => ({ roleKey: null, assurance });

const NOW = 2_000_000_000;

describe('C59 step-up boundary, as a rule', () => {
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
});

describe('C59 step-up boundary, as a rule', () => {
  it('C59 step-up boundary: no money command is reachable on the agent prefix, where no sign-in is', () => {
    // The step-up judges a person's sign-in, and an agent has none to judge, so
    // a command holding a money key stays off the agent route. A row that opens
    // one to agents fails here before it can skip the step-up.
    const opened = COMMAND_SURFACE.filter(
      (row) => isMoneyKey(row.collection, row.action) && row.agent !== 'never',
    ).map((row) => row.name);
    expect(opened).toEqual([]);
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
