// SPDX-License-Identifier: AGPL-3.0-only
//
// C40 security review, through the real API against the stand-in provider.
// One reset link's session sets one password, however many requests carry it
// at once (F1), and only a session it can spend (F2); a refused or replayed
// reset is recorded where the login is mapped (F3); a second factor outlives
// the reset (F5a); and a fault in any business's change, or a lost answer to
// the password set, still leaves every session ended (F5b, N1). Of two claims
// of one session at once, exactly one is told yes (N3).

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  claimProviderSession,
  recordFactorEnrolled,
  recordFactorVerified,
} from '../../packages/core-records/src/index.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { ACCEPTANCE_ISSUER, serverUrl } from '../acceptance/world.ts';
import { signBearer } from '../support/sign-in.ts';
import { json } from './c58-sessions-world.ts';
import {
  answerWith,
  attemptsOf,
  auditOf,
  doorAnswer,
  faultTheChangeIn,
  freshMember,
  GOOD,
  inBravoToo,
  now,
  seen,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();

const NEW_PASSWORD = 'a long new password 7f3c';
const INVALID = { status: 401, code: 'RESET_LINK_INVALID' };
const ENDED = 'AUTH_SESSION_EXPIRED';

const answerOf = (answer: { status: number; body: Record<string, unknown> }) => ({
  status: answer.status,
  code: answer.body['code'],
});

const refusedIn = async (business: string, subject: string): Promise<readonly unknown[]> =>
  (await attemptsOf(business, subject))
    .filter((one) => one.outcome === 'refused')
    .map((one) => one.refusal_code);

const C40 = describe.skipIf(serverUrl === undefined);

C40('C40 review: one link, one password', () => {
  it('C40 F1 two sets at once on one link: one 200, one 401, one PUT /user', async () => {
    const kim = await freshMember('kim');
    const recovery = await tokenFor(kim.presented.subject, randomUUID(), 'recovery', now() - 30);
    const answers = await Promise.all([
      setPassword(recovery, NEW_PASSWORD),
      setPassword(recovery, 'another long new password'),
    ]);
    const statuses = answers.map((one) => one.status).toSorted((a, b) => a - b);
    expect(statuses).toEqual([200, 401]);
    expect(answers.map((one) => answerOf(one))).toContainEqual(INVALID);
    expect(seen.filter((one) => one.route === 'PUT /user')).toHaveLength(1);
    // F3: the refused one is recorded where the login is mapped.
    expect(await refusedIn(world.alpha, kim.presented.subject)).toEqual([ENDED]);
  });

  it('C40 F2 a recovery token naming no session it can spend sets nothing', async () => {
    const lou = await freshMember('lou');
    const at = now() - 30;
    for (const named of [{}, { session_id: 'not-a-session' }]) {
      // oxlint-disable-next-line no-await-in-loop
      const token = await signBearer({
        sub: lou.presented.subject,
        aud: 'authenticated',
        iss: ACCEPTANCE_ISSUER,
        exp: now() + 600,
        aal: 'aal1',
        ...named,
        amr: [{ method: 'recovery', timestamp: at }],
      });
      // oxlint-disable-next-line no-await-in-loop
      expect(answerOf(await setPassword(token, NEW_PASSWORD))).toEqual(INVALID);
    }
    expect(seen).toEqual([]);
  });

  it('C40 F3 a replayed reset is recorded, refused, in every business the login reaches', async () => {
    const lea = await freshMember('lea');
    await inBravoToo(lea.presented.subject, 'lea-in-bravo');
    const recovery = await tokenFor(lea.presented.subject, randomUUID(), 'recovery', now() - 30);
    expect((await setPassword(recovery, NEW_PASSWORD)).status).toBe(200);
    expect(answerOf(await setPassword(recovery, NEW_PASSWORD))).toEqual(INVALID);
    expect(await refusedIn(world.alpha, lea.presented.subject)).toEqual([ENDED]);
    expect(await refusedIn(world.bravo, lea.presented.subject)).toEqual([ENDED]);
  });
});

C40('C40 review: the second factor', () => {
  it('C40 F5a a verified second factor outlives the reset; a recovery session stays one', async () => {
    const ora = await freshMember('ora');
    const subject = ora.presented.subject;
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      const factor = await recordFactorEnrolled(tx, {
        personId: ora.personId,
        provider: 'supabase',
        providerFactorId: `factor-${randomUUID()}`,
      });
      await recordFactorVerified(tx, { personId: ora.personId, factorId: factor.id, subject });
    });
    const recovery = await tokenFor(subject, randomUUID(), 'recovery', now() - 30);
    expect((await setPassword(recovery, NEW_PASSWORD)).status).toBe(200);
    // The new password alone (aal1) is not yet a sign-in for this login.
    const after = await tokenFor(subject, randomUUID(), 'password', now() + 1);
    expect(await doorAnswer(after, 'alpha')).toBe('AUTH_SECOND_FACTOR_REQUIRED');
    // A recovery session claiming aal2 is still no session at the door.
    const at = now();
    const claimsTwo = await signBearer({
      sub: subject,
      aud: 'authenticated',
      iss: ACCEPTANCE_ISSUER,
      exp: at + 600,
      aal: 'aal2',
      session_id: randomUUID(),
      amr: [
        { method: 'recovery', timestamp: at - 10 },
        { method: 'totp', timestamp: at - 5 },
      ],
    });
    expect(await doorAnswer(claimsTwo, 'alpha')).toBe(ENDED);
  });
});

C40('C40 review: a fault after the provider', () => {
  it('C40 F5b a fault in bravo’s change after the password set: 503, sessions still ended', async () => {
    const pia = await freshMember('pia');
    const bravoActor = await inBravoToo(pia.presented.subject, 'pia-in-bravo');
    const old = await tokenFor(pia.presented.subject, randomUUID(), 'password', now() - 60);
    const recovery = await tokenFor(pia.presented.subject, randomUUID(), 'recovery', now() - 30);
    expect(await doorAnswer(old, 'bravo')).toBe('served');
    faultTheChangeIn(world.bravo);

    const set = await setPassword(recovery, NEW_PASSWORD);

    expect(answerOf(set)).toEqual({ status: 503, code: 'RESET_FAULT' });
    // The provider set the password, then was asked to sign out the others.
    expect(seen.map((one) => one.route)).toEqual(['PUT /user', 'POST /logout?scope=others']);
    // Alpha's change committed and holds in every business; bravo's audit rolled back.
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    const changed = 'account.password_changed';
    const alpha = await auditOf(world.alpha, changed);
    const bravo = await auditOf(world.bravo, changed);
    expect(alpha.filter((row) => row.actor_id === pia.actorId)).toHaveLength(1);
    expect(bravo.filter((row) => row.actor_id === bravoActor)).toEqual([]);
    // The link is spent: the person asks for another.
    expect(answerOf(await setPassword(recovery, NEW_PASSWORD))).toEqual(INVALID);
  });
});

/** The same login in alpha and bravo, a session signed in a minute ago, and a reset link's. */
async function bothBusinesses(name: string) {
  const member = await freshMember(name);
  await inBravoToo(member.presented.subject, `${name}-in-bravo`);
  const old = await tokenFor(member.presented.subject, randomUUID(), 'password', now() - 60);
  const recovery = await tokenFor(member.presented.subject, randomUUID(), 'recovery', now() - 30);
  expect(await doorAnswer(old, 'alpha')).toBe('served');
  expect(await doorAnswer(old, 'bravo')).toBe('served');
  return { old, recovery };
}

C40('C40 review: the claim ends every session before the provider is asked', () => {
  it('C40 N1a a fault in the first business’s change after the password set: sessions ended in both', async () => {
    const { old, recovery } = await bothBusinesses('quinn');
    faultTheChangeIn(world.alpha);

    const set = await setPassword(recovery, NEW_PASSWORD);

    expect(answerOf(set)).toEqual({ status: 503, code: 'RESET_FAULT' });
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    expect(seen.map((one) => one.route)).toEqual(['PUT /user', 'POST /logout?scope=others']);
  });

  it('C40 N1b the provider commits PUT /user and answers 500: sessions ended in both', async () => {
    const { old, recovery } = await bothBusinesses('rae');
    // The stand-in "commits" (the request reached it) and the answer is lost to a 500.
    answerWith({ ...GOOD, 'PUT /user': json(500, { msg: 'committed, then failed' }) });

    const set = await setPassword(recovery, NEW_PASSWORD);

    expect(answerOf(set)).toEqual({ status: 503, code: 'RESET_UNAVAILABLE' });
    expect(await doorAnswer(old, 'alpha')).toBe(ENDED);
    expect(await doorAnswer(old, 'bravo')).toBe(ENDED);
    expect(seen.map((one) => one.route)).toEqual(['PUT /user', 'POST /logout?scope=others']);
  });
});

/** Resolves once a backend of this database waits on a lock over the claim's table. */
async function claimBlocked(deadline: number): Promise<void> {
  const rows = await world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'
        and query like '%ended_provider_sessions%'`,
  );
  if (Number(rows[0]?.n) > 0) return;
  if (Date.now() > deadline) throw new Error('the second claim never waited on the first');
  await new Promise((resolve) => {
    setTimeout(resolve, 25);
  });
  await world.db.admin.execute('select pg_stat_clear_snapshot()');
  await claimBlocked(deadline);
}

/** A promise and the call that settles it. */
function gate(): { readonly opened: Promise<void>; readonly open: () => void } {
  const settle: { resolve?: () => void } = {};
  const opened = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  return { opened, open: () => settle.resolve?.() };
}

C40('C40 review: the claim, at the records', () => {
  it('C40 N3 two claims of one session at once: exactly one is told yes', async () => {
    const sessionId = randomUUID();
    const held = gate();
    const claimedFirst = gate();
    // A connection of its own: the app pool's one would queue the second claim, not race it.
    const other = connect(world.db.appUrl, { source: 'runtime' });
    // The first claim inserts and holds its transaction open.
    const first = world.db.app.withBusiness(world.alpha, async (tx) => {
      const won = await claimProviderSession(tx, sessionId);
      claimedFirst.open();
      await held.opened;
      return won;
    });
    await claimedFirst.opened;
    // The second reaches its insert and waits on the first's uncommitted row.
    const second = other.withBusiness(
      world.alpha,
      async (tx) => await claimProviderSession(tx, sessionId),
    );
    try {
      await claimBlocked(Date.now() + 10_000);
    } finally {
      held.open();
    }
    try {
      expect(await Promise.all([first, second])).toEqual([true, false]);
    } finally {
      await other.close();
    }
  });
});
