// SPDX-License-Identifier: AGPL-3.0-only
//
// Who may approve, up to commit (C52-A), through the real API route, each
// request on a connection of its own (`RegistryWorld.asWide`).
//
// A change's last waits are the activation's lock and the business's audit
// chain, which every audited write takes. A session signed out while the
// change waits on the activation refuses it (C58: an ended session is over
// from that commit), and a grant that runs out while the change waits on the
// audit chain refuses it too. Each of the four writes, nothing applied.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signOutSession, type FactorProvider } from '../../packages/core-commands/src/index.ts';
import { ISSUER, type Answer } from '../api/fixture.ts';
import { signBearer } from '../support/sign-in.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  expiringGrant,
  heldWhile,
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

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C52-A approval up to commit', () => {
  let w: RegistryWorld;

  beforeAll(async () => {
    w = await createRegistryWorld('c52m');
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

  it('C52-A signed out while waiting: no change applies after the session that sent it was signed out', async () => {
    const sends = await fourCases();
    const answers: Answer[] = [];
    const ended: unknown[] = [];
    const later: Answer[] = [];
    for (const [activationId, name, body] of sends) {
      const sessionId = randomUUID();
      const presented = { ...w.automationOnly.presented, sessionId };
      // eslint-disable-next-line no-await-in-loop -- one session per case
      const bearer = await signBearer({
        sub: presented.subject,
        aud: 'authenticated',
        iss: ISSUER,
        role: 'authenticated',
        exp: Math.floor(Date.now() / 1000) + 600,
        session_id: sessionId,
      });
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      const answer = await heldWhile(
        w,
        activationId,
        async () => await w.asWide(w.automationOnly, name, body, bearer),
        async () => {
          const caller = {
            database: w.controls.fixture.db.app,
            businessId: w.alpha,
            presented,
            accessToken: bearer,
          };
          ended.push(await signOutSession(caller, {}, provider));
        },
      );
      answers.push(answer);
      // eslint-disable-next-line no-await-in-loop -- the next call on the ended session
      later.push(await w.asWide(w.automationOnly, 'automation.registry', {}, bearer));
    }
    expect(ended).toStrictEqual(
      Array.from({ length: 4 }, () => ({ ended: 1, signedOutAtProvider: true })),
    );
    expect(
      answers.map((one) => [one.status, one.body['code']]),
      JSON.stringify(answers.map((one) => one.body)),
    ).toStrictEqual(Array.from({ length: 4 }, () => [401, 'AUTH_SESSION_EXPIRED']));
    expect(later.map((one) => [one.status, one.body['code']])).toStrictEqual(
      Array.from({ length: 4 }, () => [401, 'AUTH_SESSION_EXPIRED']),
    );
    expect(await stateOf(sends)).toStrictEqual(untouched);
  }, 120_000);

  /** The owner's hold on the business's audit chain: the key `audit_events_chain` takes. */
  const holdingChain = async (execute: Execute): Promise<unknown> =>
    await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [w.alpha.toLowerCase()]);

  it('C52-A expired while waiting on the audit chain: no change applies after its automation:manage grant ran out', async () => {
    const sends = await fourCases();
    const answers: Answer[] = [];
    for (const [, name, body] of sends) {
      // eslint-disable-next-line no-await-in-loop -- one grant per case
      const grantId = await expiringGrant(w);
      // eslint-disable-next-line no-await-in-loop -- one race at a time
      const answer = await sentWhileHeld(
        w,
        holdingChain,
        async () => await w.asWide(w.plain, name, body),
        untilExpired(grantId),
      );
      answers.push(answer);
    }
    expect(
      answers.map((one) => [one.status, one.body['code']]),
      JSON.stringify(answers.map((one) => one.body)),
    ).toStrictEqual(Array.from({ length: 4 }, () => [403, 'SCOPE_NOT_GRANTED']));
    expect(await stateOf(sends)).toStrictEqual(untouched);
  }, 120_000);
});
