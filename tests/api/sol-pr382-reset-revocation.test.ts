// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { setPasswordByRecovery } from '../../packages/core-commands/src/index.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { agentPath, bearer, call } from '../acceptance/world.ts';
import {
  answerWith,
  doorAnswer,
  freshMember,
  GOOD,
  inBravoToo,
  now,
  setPassword,
  tokenFor,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';
import { json } from './c58-sessions-world.ts';

usePasswordWorld();

function gate() {
  const settle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, open: () => settle.resolve?.() };
}

it('Sol proof, criterion 5: a reset revoked after standing was checked cannot claim another password change', async () => {
  const member = await freshMember('sol-stale-link');
  const subject = member.presented.subject;
  await inBravoToo(subject, 'sol-stale-link-bravo');
  const sessionId = randomUUID();
  const at = now() - 30;
  const token = await tokenFor(subject, sessionId, 'recovery', at);
  const replacement = await tokenFor(subject, randomUUID(), 'recovery', at);
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
        'loginId' in result
      ) {
        paused = true;
        checked.open();
        await release.promise;
      }
      return result;
    },
  };
  // No provider call from the stale request is expected. Record one if it happens.
  const staleCalls: string[] = [];
  const stale = setPasswordByRecovery(
    delayed,
    [world.alpha, world.bravo],
    {
      setPassword: async () => {
        staleCalls.push('setPassword');
        return { ok: true, value: subject };
      },
      signOut: async () => ({ ok: true, value: undefined }),
    },
    {
      presented: {
        provider: 'supabase',
        subject,
        sessionId,
        recovery: true,
        assurance: { level: 'aal1', signedInAt: at, factorAt: null },
      },
      accessToken: token,
      password: 'sol stale link password',
    },
  );
  await checked.promise;
  try {
    // Local revocation must hold even when the provider cannot sign out the other session.
    answerWith({ ...GOOD, 'POST /logout?scope=others': json(500, {}) });
    expect((await setPassword(replacement, 'sol replacement password')).body).toEqual({
      signedOutAtProvider: false,
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

it('Sol proof, criterion 3: the agent queue refuses a recovery session', async () => {
  const recovery = await tokenFor(world.agent.subject, randomUUID(), 'recovery', now() - 30);
  const ordinary = await tokenFor(world.agent.subject, randomUUID(), 'password', now() - 30);
  const path = agentPath('alpha', '/task/queue');
  const normal = await call(world.api, path, { operationId: randomUUID() }, bearer(ordinary));
  expect(normal.status).toBe(200);
  const reset = await call(world.api, path, { operationId: randomUUID() }, bearer(recovery));
  expect({ status: reset.status, code: reset.body['code'] }).toEqual({
    status: 401,
    code: 'AUTH_SESSION_EXPIRED',
  });
});

it('Sol proof, criterion 3: a password session opened before the reset commit is refused after provider logout', async () => {
  const member = await freshMember('sol-commit-window');
  const subject = member.presented.subject;
  const sessionId = randomUUID();
  const at = now() - 30;
  const token = await tokenFor(subject, sessionId, 'recovery', at);
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
  const providerCalls: string[] = [];
  const pending = setPasswordByRecovery(
    delayed,
    [world.alpha],
    {
      setPassword: async () => {
        providerCalls.push('setPassword');
        return { ok: true, value: subject };
      },
      signOut: async (_accessToken, scope) => {
        providerCalls.push(scope);
        return { ok: true, value: undefined };
      },
    },
    {
      presented: {
        provider: 'supabase',
        subject,
        sessionId,
        recovery: true,
        assurance: { level: 'aal1', signedInAt: at, factorAt: null },
      },
      accessToken: token,
      password: 'sol commit window password',
    },
  );
  await audited.promise;
  let during: string;
  try {
    // The new session starts after the transaction timestamp, before its commit.
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    during = await tokenFor(subject, randomUUID(), 'password', now());
  } finally {
    release.open();
  }
  expect(await pending).toEqual({ ok: true, signedOutAtProvider: true });
  expect(providerCalls).toEqual(['setPassword', 'others', 'local']);
  expect(await doorAnswer(during, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
});
