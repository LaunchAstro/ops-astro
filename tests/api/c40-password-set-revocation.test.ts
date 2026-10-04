// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's PR #382 round 1 proofs, criteria 3 and 5, under ORCH77-C40B: the
// reset runs on our own one-time token, so no recovery session exists. The
// agent queue proof becomes "a token's use yields no bearer session at all",
// and the paused reset proof becomes "a paused reset whose token was spent
// meanwhile is refused". The commit-window proof is kept on the token, its
// commit a whole second after the session's stamp (round 3, criterion 5).
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { PASSWORD_SET_PATH } from '../../apps/api/password-set.ts';
import { setPasswordByToken } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  api,
  broker,
  doorAnswer,
  freshMember,
  inBravoToo,
  mintToken,
  now,
  seen,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

usePasswordWorld();

function gate() {
  const settle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, open: () => settle.resolve?.() };
}

const SOL = it.skipIf(serverUrl === undefined);

/** The app database, paused once after the login's standing in bravo is read, until released. */
function pausedAfterBravoStanding() {
  const checked = gate();
  const release = gate();
  let paused = false;
  const delayed: Database = {
    ...world.db.app,
    async withBusiness(business, run) {
      const result = await world.db.app.withBusiness(business, run);
      if (
        !paused &&
        business === world.bravo &&
        typeof result === 'object' &&
        result !== null &&
        'session' in result
      ) {
        paused = true;
        checked.open();
        await release.promise;
      }
      return result;
    },
  };
  return { delayed, checked, release };
}

SOL('a reset revoked after standing was checked cannot claim another password change', async () => {
  const member = await freshMember('sol-stale-link');
  const subject = member.presented.subject;
  await inBravoToo(subject, 'sol-stale-link-bravo');
  const token = await mintToken(subject);
  const replacement = await mintToken(subject);
  const { delayed, checked, release } = pausedAfterBravoStanding();
  // No provider call from the stale request is expected. Record one if it happens.
  const staleCalls: string[] = [];
  const stale = setPasswordByToken(
    delayed,
    [world.alpha, world.bravo],
    {
      broker: {
        ...broker,
        custody: {
          ...broker.custody,
          dispatch: async (...args) => {
            staleCalls.push('setPassword');
            return await broker.custody.dispatch(...args);
          },
        },
      },
    },
    { token, password: 'sol stale link password' },
  );
  await checked.promise;
  try {
    expect((await setPassword(replacement, 'sol replacement password')).body).toEqual({
      passwordSet: true,
    });
    expect((await setPassword(token, 'sol replay password')).status).toBe(401);
  } finally {
    release.open();
  }
  const result = await stale;
  expect({ result, staleCalls }).toEqual({
    result: { ok: false, code: 'RESET_LINK_INVALID' },
    staleCalls: [],
  });
});

SOL('the agent queue refuses a recovery session', async () => {
  // No recovery session exists: a token's use answers no credential and sets no cookie,
  // and the token itself is no bearer anywhere, the agent queue included.
  const member = await freshMember('sol-no-bearer');
  const token = await mintToken(member.presented.subject);
  const ordinary = await tokenFor(world.agent.subject, randomUUID(), now() - 30);
  const path = agentPath('alpha', '/task/queue');
  const normal = await call(world.api, path, { operationId: randomUUID() }, bearer(ordinary));
  expect(normal.status).toBe(200);
  const used = await api.fetch(
    new Request(`http://api.test${PASSWORD_SET_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, password: 'sol no bearer password' }),
    }),
  );
  expect({
    status: used.status,
    body: await used.json(),
    cookie: used.headers.get('set-cookie'),
  }).toEqual({ status: 200, body: { passwordSet: true }, cookie: null });
  const queue = await call(world.api, path, { operationId: randomUUID() }, bearer(token));
  const door = await doorAnswer(token, 'alpha');
  expect({ queue: [queue.status, queue.body['code']], door }).toEqual({
    queue: [401, 'DELEGATION_NOT_LIVE'],
    door: 'AUTH_UNKNOWN_LOGIN',
  });
});

SOL(
  'a password session opened before the reset commit is refused once the reset ends sessions',
  async () => {
    const member = await freshMember('sol-commit-window');
    const subject = member.presented.subject;
    const token = await mintToken(subject);
    const audited = gate();
    const release = gate();
    const delayed: Database = {
      ...world.db.app,
      async withBusiness(business, run) {
        return await world.db.app.withBusiness(
          business,
          async (tx) =>
            await run({
              ...tx,
              async query<Row>(text: string, parameters?: readonly unknown[]) {
                const rows = await tx.query<Row>(text, parameters);
                if (text.includes('insert into audit_events')) {
                  audited.open();
                  await release.promise;
                }
                return rows;
              },
            }),
        );
      },
    };
    const pending = setPasswordByToken(
      delayed,
      [world.alpha],
      { broker },
      { token, password: 'sol commit window password' },
    );
    await audited.promise;
    let during: string;
    try {
      // The new session starts after the transaction timestamp, before its commit.
      await new Promise((resolve) => {
        setTimeout(resolve, 1100);
      });
      during = await tokenFor(subject, randomUUID(), now());
      // A whole second before the commit: a stamp of its own second is served (round 3, c5).
      await delay(1000 - (Date.now() % 1000) + 25);
    } finally {
      release.open();
    }
    expect(await pending).toEqual({ ok: true });
    expect(seen.map((one) => one.route)).toEqual([`PUT /auth/v1/admin/users/${subject}`]);
    expect(await doorAnswer(during, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
  },
);
