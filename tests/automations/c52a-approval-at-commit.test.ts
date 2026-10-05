// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may approve, up to commit (C52-A), through the real API route, each
// request on a connection of its own (`RegistryWorld.asWide`).
//
// A change's last waits are the activation's lock and the business's audit
// chain, which every audited write takes. A session signed out while the
// change waits on the activation refuses it (C58: an ended session is over
// from that commit), and so does one signed out in another business its login
// reaches while the change waits on the audit chain (0061); the same attempt
// sent again from a new sign-in is kept as a scope refusal, not a sign-out. A
// grant that runs out while the change waits on the audit chain refuses it
// too. Each of the four writes, nothing applied. A sign-out through bravo
// sent once the change has read its session live under alpha's chain waits
// for the change to commit (PRV-oa-984-R2.1).

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signOutSession } from '../../packages/core-commands/src/index.ts';
import {
  endOtherSeenSessions,
  openResetWindow,
  settleResetWindow,
  waitForNextSecond,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import type { Answer } from '../api/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { expiringGrant, sentWhileHeld, untilExpired, type Execute } from './race-hold.ts';
import { fourCasesOf, stateIn, untouched, type Send } from './approval-cases.ts';
import { createRegistryWorld, type RegistryWorld } from './registry-world.ts';
import { provider, signedInOf, signOutWaits, stopAfterLastSessionRead } from './session-stop.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's hold on one activation's row. */
const holdingActivation =
  (activationId: string) =>
  async (execute: Execute): Promise<unknown> =>
    await execute('select 1 from public.activations where id = $1 for update', [activationId]);

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A approval up to commit', () => {
  let w: RegistryWorld;
  let bravoPersonId = '';

  beforeAll(async () => {
    w = await createRegistryWorld('c52m');
    // automationOnly's login reaches bravo too, so a sign-out there ends its session here (0061).
    await w.controls.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'automationonly-bravo');
      bravoPersonId = personId;
      const actorId = await insertActor(tx, personId);
      await insertMembership(tx, personId);
      const loginId = await insertLogin(tx, w.automationOnly.presented.subject);
      await insertMapping(tx, loginId, personId, actorId);
    });
    // Each wide connection opened before the race: one opened while the lock is polled can stall.
    await Promise.all(
      [1, 2, 3, 4].map(async () => await w.asWide(w.admin, 'automation.registry', {})),
    );
  }, 120_000);

  afterAll(async () => {
    await w?.drop();
  });

  const fourCases = async () => await fourCasesOf(w);
  const stateOf = async (sends: readonly Send[]) => await stateIn(w, sends);

  const signedIn = async () => await signedInOf(w);

  /** The owner's hold on alpha's audit chain: the key `audit_events_chain` takes. */
  const holdingChain = async (execute: Execute): Promise<unknown> =>
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [w.alpha.toLowerCase()]);

  /**
   * One case sent on a sign-in of its own while the owner holds `hold`, that
   * session signed out through business `via` while the case waits. Then the
   * next call on it, and the same attempt sent again from a new sign-in.
   */
  const signedOutWhile = async (
    one: Send,
    hold: (execute: Execute) => Promise<unknown>,
    via: string,
  ) => {
    const [, name, body] = one;
    const sent = { ...body, operationId: randomUUID() };
    const { presented, bearer } = await signedIn();
    let ended: unknown;
    const answer = await sentWhileHeld(
      w,
      hold,
      async () => await w.asWide(w.automationOnly, name, sent, bearer),
      async () => {
        const caller = {
          database: w.controls.fixture.db.app,
          businessId: via,
          presented,
          accessToken: bearer,
        };
        ended = await signOutSession(caller, {}, provider);
      },
    );
    const later = await w.asWide(w.automationOnly, 'automation.registry', {}, bearer);
    const again = await w.asWide(w.automationOnly, name, sent, (await signedIn()).bearer);
    return [ended, ...[answer, later, again].map((reply) => [reply.status, reply.body['code']])];
  };

  /** Each case refused as its session's ending, the ended session refused next, the attempt kept as a scope refusal. */
  const SIGNED_OUT = Array.from({ length: 4 }, () => [
    { ended: 1, signedOutAtProvider: true },
    [401, 'AUTH_SESSION_EXPIRED'],
    [401, 'AUTH_SESSION_EXPIRED'],
    [403, 'SCOPE_NOT_GRANTED'],
  ]);

  it('C52-A signed out while waiting: no change applies after the session that sent it was signed out', async () => {
    const sends = await fourCases();
    const raced: unknown[] = [];
    for (const one of sends) {
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      raced.push(await signedOutWhile(one, holdingActivation(one[0]), w.alpha));
    }
    expect(raced).toStrictEqual(SIGNED_OUT);
    expect(await stateOf(sends)).toStrictEqual(untouched);
  }, 120_000);

  it('C52-A signed out elsewhere while waiting on the audit chain: no change applies after its session ended in another business', async () => {
    const sends = await fourCases();
    const raced: unknown[] = [];
    for (const one of sends) {
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      raced.push(await signedOutWhile(one, holdingChain, w.bravo));
    }
    expect(raced).toStrictEqual(SIGNED_OUT);
    expect(await stateOf(sends)).toStrictEqual(untouched);
  }, 120_000);

  /**
   * Three endings through bravo, each with how many of the four writes it races:
   * the session's own sign-out (its key) races all four; a password reset's
   * window (its subject's, opened as the reset spends its token, C40) races all
   * four, settled a whole second later as a reset that set the password is, so
   * the next sign-in is served; an end of the login's other sessions (its
   * subject's: the sessions bravo has seen are already ended, so it ends none by
   * key) races the first alone, since it ends every later sign-in of that login
   * inside the clock-skew minute too.
   */
  const ENDINGS = [
    [
      'its sign-out',
      4,
      async (presented: VerifiedSubject, accessToken: string) => {
        const caller = {
          database: w.controls.fixture.db.app,
          businessId: w.bravo,
          presented,
          accessToken,
        };
        const ended = await signOutSession(caller, {}, provider);
        return 'ended' in ended && ended.ended === 1;
      },
    ],
    [
      "a password reset's window",
      4,
      async (presented: VerifiedSubject) => {
        const bravo = w.controls.fixture.db.app;
        const reset = await bravo.withBusiness(
          w.bravo,
          async (tx) => await openResetWindow(tx, presented.subject),
        );
        await bravo.withBusiness(w.bravo, async (tx) => {
          await waitForNextSecond(tx);
          await settleResetWindow(tx, reset);
          // A whole second past the settle on the database's clock, so the next
          // race's sign-in, stamped by this process's clock, is not before it.
          await waitForNextSecond(tx);
        });
        return reset.length > 0;
      },
    ],
    [
      'an end of its other sessions',
      1,
      async (presented: VerifiedSubject) =>
        await w.controls.fixture.db.app.withBusiness(w.bravo, async (tx) => {
          const keep = randomUUID();
          return (
            (await endOtherSeenSessions(
              tx,
              bravoPersonId,
              keep,
              'end_others',
              presented.subject,
            )) === 0
          );
        }),
    ],
  ] as const;

  /**
   * One case stopped straight after its last session read (alive, alpha's
   * chain held), its session ended through bravo meanwhile. Whether the ending
   * waited for the change and ended, the change's answer, and the next call.
   */
  const endedAfterLastRead = async ([, name, body]: Send, end: (typeof ENDINGS)[number][2]) => {
    const { presented, bearer } = await signedIn();
    const { wrap, arm } = stopAfterLastSessionRead(w.alpha);
    const { stopped, release } = arm();
    const answer = w.asThrough(
      wrap,
      w.automationOnly,
      name,
      { ...body, operationId: randomUUID() },
      bearer,
    );
    await stopped;
    let finished = false;
    const ending = end(presented, bearer).finally(() => {
      finished = true;
    });
    const waited = await signOutWaits(w.holderUrl(), () => finished);
    release();
    const [reply, ended] = await Promise.all([answer, ending]);
    const later = await w.asWide(w.automationOnly, 'automation.registry', {}, bearer);
    return [waited, ended, reply.status, [later.status, later.body['code']]];
  };

  it.each(ENDINGS)(
    'C52-A signed out elsewhere after the last session read (%s): the ending waits for the change it admitted',
    async (_kind, count, end) => {
      const sends = (await fourCases()).slice(0, count);
      const raced: unknown[] = [];
      for (const one of sends) {
        // eslint-disable-next-line no-await-in-loop -- one race at a time
        raced.push(await endedAfterLastRead(one, end));
      }
      expect(raced).toStrictEqual(
        Array.from({ length: count }, () => [true, true, 200, [401, 'AUTH_SESSION_EXPIRED']]),
      );
      // Each raced write applied: its row is no longer as it was.
      const applied = await stateOf(sends);
      expect(applied.filter((one, at) => isDeepStrictEqual(one, untouched[at]))).toStrictEqual([]);
    },
    120_000,
  );

  /** One case sent while the owner holds the audit chain, let go once its grant has run out. */
  const expiredWhile = async ([, name, body]: Send): Promise<Answer> => {
    const grantId = await expiringGrant(w);
    return await sentWhileHeld(
      w,
      holdingChain,
      async () => await w.asWide(w.plain, name, body),
      async (execute) => {
        // Seen waiting while its grant still held: past the handler's checks, not refused early.
        const [row] = (await execute(
          'select clock_timestamp() < expires_at as live from public.grants where id = $1',
          [grantId],
        )) as readonly { readonly live: boolean }[];
        expect(row?.live).toBe(true);
        await untilExpired(grantId)(execute);
      },
    );
  };

  it('C52-A expired while waiting on the audit chain: no change applies after its automation:manage grant ran out', async () => {
    const sends = await fourCases();
    const answers: Answer[] = [];
    for (const one of sends) {
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      answers.push(await expiredWhile(one));
    }
    expect(
      answers.map((one) => [one.status, one.body['code']]),
      JSON.stringify(answers.map((one) => one.body)),
    ).toStrictEqual(Array.from({ length: 4 }, () => [403, 'SCOPE_NOT_GRANTED']));
    expect(await stateOf(sends)).toStrictEqual(untouched);
  }, 120_000);
});
