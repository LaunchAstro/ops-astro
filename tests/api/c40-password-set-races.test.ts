// SPDX-License-Identifier: AGPL-3.0-only
// Independent round 2 proofs. Real Postgres, API and custody; no product edits.
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/index.ts';
import {
  advisoryLock,
  recordFactorEnrolled,
  recordFactorVerified,
  type Database,
} from '../../packages/core-records/src/index.ts';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { agentPath, bearer, call, serverUrl } from '../acceptance/world.ts';
import {
  auditOf,
  answerWith,
  broker,
  doorAnswer,
  faultTheChangeIn,
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
import { json } from './c58-sessions-world.ts';

usePasswordWorld();
const SOL = it.skipIf(serverUrl === undefined);
const PASSWORD = 'sol round two new password';
const CHANGED = 'account.password_changed';

function gate() {
  const settle: { resolve?: () => void } = {};
  const promise = new Promise<void>((resolve) => {
    settle.resolve = resolve;
  });
  return { promise, open: () => settle.resolve?.() };
}

SOL('a token expiring while its row lock is held cannot set a password', async () => {
  const member = await freshMember('sol-expiry-lock');
  const token = await mintToken(member.presented.subject);
  const hash = createHash('sha256').update(token).digest('hex');
  await world.db.admin.execute(
    "update public.password_reset_tokens set expires_at = clock_timestamp() + interval '4 seconds' where token_hash = $1",
    [hash],
  );
  const locked = gate();
  const release = gate();
  const url = new URL(serverUrl ?? '');
  url.pathname = `/${world.db.name}`;
  const observer = connectAsAdmin(url.toString());
  const holder = world.db.admin.transaction(async (query) => {
    await query('select id from public.password_reset_tokens where token_hash = $1 for update', [
      hash,
    ]);
    locked.open();
    await release.promise;
  });
  await locked.promise;
  const pending = setPassword(token, PASSWORD);
  try {
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline && !waiting) {
      // oxlint-disable-next-line no-await-in-loop -- observe the real lock before polling again
      const [row] = await observer.execute<{ waiting: boolean }>(
        `select exists (select 1 from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%select login_id from password_reset_tokens%') as waiting`,
      );
      waiting = row?.waiting === true;
      if (!waiting) {
        // oxlint-disable-next-line no-await-in-loop -- the next poll follows this delay
        await delay(20);
      }
    }
    expect(waiting, 'the product spend query must actually wait on the held token row').toBe(true);
    const [live] = await observer.execute<{ live: boolean }>(
      'select expires_at > clock_timestamp() as live from public.password_reset_tokens where token_hash = $1',
      [hash],
    );
    expect(live?.live, 'the token was live when the spend query began waiting').toBe(true);
    await observer.execute(
      'select pg_sleep(greatest(0, extract(epoch from expires_at - clock_timestamp())) + 0.1) from public.password_reset_tokens where token_hash = $1',
      [hash],
    );
  } finally {
    release.open();
    await holder;
    await observer.close();
  }
  const answer = await pending;
  expect({
    status: answer.status,
    code: answer.body['code'],
    providerCalls: seen.length,
  }).toEqual({
    status: 401,
    code: 'RESET_LINK_INVALID',
    providerCalls: 0,
  });
});

SOL('a reset ends an existing agent bearer of the same login in another business', async () => {
  const subject = world.agent.subject;
  // The same provider subject is agent-mapped in alpha and person-mapped in bravo.
  // Each mapping is written through the application role and obeys 0008.
  await inBravoToo(subject, 'sol-agent-login-bravo');
  const ordinary = await tokenFor(subject, randomUUID(), now() - 60);
  const path = agentPath('alpha', '/task/queue');
  const before = await call(world.api, path, { operationId: randomUUID() }, bearer(ordinary));
  expect(before.status).toBe(200);
  const reset = await setPassword(await mintToken(subject, world.bravo), PASSWORD);
  expect(reset.status).toBe(200);
  const after = await call(world.api, path, { operationId: randomUUID() }, bearer(ordinary));
  expect({ status: after.status, code: after.body['code'] }).toEqual({
    status: 401,
    code: 'AUTH_SESSION_EXPIRED',
  });
});

SOL('a factor verified after standing was read prevents the paused password reset', async () => {
  const member = await freshMember('sol-new-factor');
  const subject = member.presented.subject;
  await inBravoToo(subject, 'sol-new-factor-bravo');
  const token = await mintToken(subject);
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
  const pending = setPasswordByToken(
    delayed,
    [world.alpha, world.bravo],
    { broker },
    { token, password: PASSWORD },
  );
  await checked.promise;
  try {
    // C59 uses this subject lock. The reset takes no lock shared with it.
    await world.db.app.withBusiness(world.alpha, async (tx) => {
      await advisoryLock(
        tx,
        `second-factor-subject:${createHash('sha256').update(subject).digest('hex')}`,
      );
      const factor = await recordFactorEnrolled(tx, {
        personId: member.personId,
        provider: 'supabase',
        providerFactorId: randomUUID(),
      });
      await recordFactorVerified(tx, { personId: member.personId, factorId: factor.id, subject });
    });
    expect((await setPassword(token, PASSWORD)).body).toEqual({ code: 'RESET_NEEDS_SUPPORT' });
    expect(seen).toHaveLength(0);
  } finally {
    release.open();
  }
  const result = await pending;
  const [stored] = await world.db.app.withBusiness(
    world.alpha,
    async (tx) =>
      await tx.query<{ spent: boolean }>(
        'select spent_at is not null as spent from password_reset_tokens where token_hash = $1',
        [createHash('sha256').update(token).digest('hex')],
      ),
  );
  expect({ result, spent: stored?.spent, providerCalls: seen.length }).toEqual({
    result: { ok: false, code: 'RESET_NEEDS_SUPPORT' },
    spent: false,
    providerCalls: 0,
  });
});

SOL('a reset failing in the second business audits nothing in either business', async () => {
  const member = await freshMember('sol-partial-audit');
  const subject = member.presented.subject;
  const bravoActor = await inBravoToo(subject, 'sol-partial-audit-bravo');
  faultTheChangeIn(world.bravo);
  const answer = await setPassword(await mintToken(subject), PASSWORD);
  expect({ status: answer.status, code: answer.body['code'] }).toEqual({
    status: 503,
    code: 'RESET_FAULT',
  });
  expect(seen).toHaveLength(1);
  const alpha = (await auditOf(world.alpha, CHANGED)).filter(
    (row) => row.actor_id === member.actorId,
  );
  const bravo = (await auditOf(world.bravo, CHANGED)).filter((row) => row.actor_id === bravoActor);
  expect({
    alpha: alpha.map((row) => row.outcome),
    bravo: bravo.map((row) => row.outcome),
  }).toEqual({ alpha: [], bravo: [] });
});

SOL(
  'a mid-reset session remains ended after a database outage prevents the final ending',
  async () => {
    const member = await freshMember('sol-outage-ending');
    const subject = member.presented.subject;
    const token = await mintToken(subject);
    let during = '';
    let setupError: unknown;
    // The generated database name is an identifier, never request data.
    if (!/^[a-z][a-z0-9_]+$/u.test(world.db.name)) throw new Error('unsafe fixture database name');
    const databaseName = `"${world.db.name}"`;
    const server = connectAsAdmin(serverUrl ?? '');
    answerWith((request, response) => {
      void (async () => {
        await delay(1100);
        during = await tokenFor(subject, randomUUID(), now());
        // Stop new connections, then sever the existing application connection.
        // The owner connection stays up so the fixture can restore availability.
        await server.execute(`alter database ${databaseName} allow_connections false`);
        await world.db.admin.execute(
          'select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and usename = $1',
          [world.db.loginRole],
        );
        json(500, {})(request, response);
      })().catch((error: unknown) => {
        setupError = error;
        json(500, {})(request, response);
      });
    });
    let status: number;
    try {
      status = (await setPassword(token, PASSWORD)).status;
    } finally {
      await server.execute(`alter database ${databaseName} allow_connections true`);
      await server.close();
    }
    expect(setupError).toBeUndefined();
    expect(status).toBe(503);
    expect(during).not.toBe('');
    expect(await doorAnswer(during, 'alpha')).toBe('AUTH_SESSION_EXPIRED');
  },
);
