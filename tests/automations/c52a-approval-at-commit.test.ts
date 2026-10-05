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
// too. Each of the four writes, nothing applied.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signOutSession, type FactorProvider } from '../../packages/core-commands/src/index.ts';
import { ISSUER, type Answer } from '../api/fixture.ts';
import {
  insertActor,
  insertLogin,
  insertMapping,
  insertMembership,
  insertPerson,
} from '../identity/fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  expiringGrant,
  pinnedFirstOf,
  sentWhileHeld,
  untilExpired,
  type Execute,
} from './race-hold.ts';
import { createRegistryWorld, detail, type RegistryWorld } from './registry-world.ts';

const serverUrl = databaseUrlFromEnvironment();

/** A provider that confirms every sign-out and is asked for nothing else. */
const done = Promise.resolve({ ok: true, value: undefined } as const);
const provider: FactorProvider = {
  enrol: () => Promise.resolve({ ok: false, fault: 'refused' }),
  verify: () => Promise.resolve({ ok: false, fault: 'refused' }),
  remove: () => done,
  signOut: () => done,
};

/** The owner's hold on one activation's row. */
const holdingActivation =
  (activationId: string) =>
  async (execute: Execute): Promise<unknown> =>
    await execute('select 1 from public.activations where id = $1 for update', [activationId]);

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A approval up to commit', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c52m');
    // automationOnly's login reaches bravo too, so a sign-out there ends its session here (0061).
    await w.controls.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      const personId = await insertPerson(tx, 'automationonly-bravo');
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

  /** The activation as the owner's registry shows it. */
  const shownOf = async (activationId: string) =>
    (await w.registry(w.admin)).definitions
      .flatMap((one) => one.activations)
      .find((one) => one.id === activationId);

  /** Four activations: one to adopt on, one adopted twice to roll back, one to turn off, one approval to revoke. */
  const fourCases = async () => {
    const adoptCase = await pinnedFirstOf(w);
    const backCase = await pinnedFirstOf(w);
    const firstOfBack = (await shownOf(backCase.activationId))?.versionId;
    for (const [versionId, expectedRevision] of [
      [firstOfBack, 1],
      [backCase.second, 2],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one adoption after another
      const one = await w.as(w.admin, 'activation.adopt', {
        activationId: backCase.activationId,
        versionId,
        expectedRevision,
      });
      expect(one.status).toBe(200);
    }
    const offCase = await pinnedFirstOf(w);
    const revokeCase = await pinnedFirstOf(w);
    const adopted = await w.as(w.admin, 'activation.adopt', {
      activationId: revokeCase.activationId,
      versionId: (await shownOf(revokeCase.activationId))?.versionId,
      expectedRevision: 1,
    });
    const approvalId = String(detail(adopted)['approvalId']);
    const sends: readonly (readonly [string, string, Record<string, unknown>])[] = [
      [
        adoptCase.activationId,
        'activation.adopt',
        { activationId: adoptCase.activationId, versionId: adoptCase.second, expectedRevision: 1 },
      ],
      [
        backCase.activationId,
        'activation.roll_back',
        { activationId: backCase.activationId, expectedRevision: 3 },
      ],
      [
        offCase.activationId,
        'activation.turn_off',
        { activationId: offCase.activationId, expectedRevision: 1 },
      ],
      [revokeCase.activationId, 'approval.revoke', { approvalId }],
    ];
    return sends;
  };

  /** Each of the four cases as the owner shows it: revision, switch, and whether its approval is revoked. */
  const untouched = [
    [1, true, null],
    [3, true, false],
    [1, true, null],
    [2, true, false],
  ];
  const stateOf = async (sends: Awaited<ReturnType<typeof fourCases>>) => {
    const shown = await Promise.all(sends.map(async ([id]) => await shownOf(id)));
    return shown.map((one) => [one?.revision, one?.enabled, one?.approval?.revoked ?? null]);
  };

  type Send = Awaited<ReturnType<typeof fourCases>>[number];

  /** A new sign-in of automationOnly's: its own provider session, and the token it verifies to. */
  const signedIn = async () => {
    const sessionId = randomUUID();
    const presented = { ...w.automationOnly.presented, sessionId };
    const bearer = await signBearer({
      sub: presented.subject,
      aud: 'authenticated',
      iss: ISSUER,
      role: 'authenticated',
      exp: Math.floor(Date.now() / 1000) + 600,
      session_id: sessionId,
    });
    return { presented, bearer };
  };

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
