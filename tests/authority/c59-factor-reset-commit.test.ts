// SPDX-License-Identifier: AGPL-3.0-only
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { settleFactorResets } from '../../packages/core-commands/src/index.ts';
import { retryFactorResets } from '../../apps/endings/pass.ts';
import { lockAccess, type Database } from '../../packages/core-records/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import { harness, nowSeconds, useEndAccessWorld } from './c58-end-access-world.ts';
import {
  factorFake,
  memberWithFactor,
  owedReset,
  reset,
  resetState,
  served,
  sessionToken,
  withFactor,
} from './c59-factor-reset-world.ts';
import { apiWith } from './c58-end-access-world.ts';
import { changed, fingerprint, undeclared } from '../operations/s0-5-effect-diff.ts';

useEndAccessWorld();

const noOperation = () => {};

function latch(): { readonly promise: Promise<void>; readonly open: () => void } {
  let open = noOperation;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

// eslint-disable-next-line max-lines-per-function -- the race, its pause and its check read in one place
async function revokedBeforeLockRefused(): Promise<void> {
  const { db, alpha } = harness.world;
  const caller = await enrol(db.app, alpha, 'sol-reset-caller');
  const target = await enrol(db.app, alpha, 'sol-reset-target');
  await withFactor(target);
  const grantId = await db.app.withBusiness(
    alpha,
    async (tx) => await grantTo(tx, caller, 'manage', WHOLE_BUSINESS, false, 'settings'),
  );
  const before = await resetState(target);
  const reached = latch();
  const resume = latch();
  // Pause at the handler's first access-lock request, after the real
  // envelope has admitted the caller and checked their live grant.
  const paused: Database = {
    log: db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await db.app.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters = []) => {
              if (sql.includes('pg_advisory_xact_lock') && parameters[0] === `access:${alpha}`) {
                reached.open();
                await resume.promise;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
  const pending = executeCommand(paused, alpha, caller.presented, 'api', {
    command: 'access.reset_factor',
    operationId: randomUUID(),
    holderId: target.personId,
  });
  await reached.promise;
  try {
    // Commit the revocation while holding the same access lock used by
    // access.revoke. The owner connection avoids the paused app pool.
    await db.admin.transaction(async (execute) => {
      await execute("select set_config('app.business_id', $1, true)", [alpha]);
      await lockAccess({ businessId: alpha, query: execute });
      await execute('update public.grants set revoked_at = clock_timestamp() where id = $1', [
        grantId,
      ]);
    });
  } finally {
    resume.open();
  }
  const answer = await pending;
  expect(isCommandRefusal(answer) ? answer.code : 'ok').toBe('SCOPE_NOT_GRANTED');
  expect(await resetState(target)).toEqual(before);
}

async function claimedResetCountedOwed(): Promise<void> {
  const { db, alpha } = harness.world;
  const owed = await owedReset('sol-backlog');
  await settleFactorResets(
    db.app,
    alpha,
    factorFake([{ ok: false, fault: 'unreachable' }]).provider,
    {
      only: [owed.id],
    },
  );
  expect((await resetState(owed.person)).resets).toEqual([
    expect.objectContaining({ done: false, attempts: 1, fault: 'unreachable' }),
  ]);
  const skipped = factorFake();
  const remaining = await retryFactorResets(db.admin, db.app, skipped.provider);
  expect(skipped.calls.filter((call) => call.factorId === owed.factorId)).toHaveLength(0);
  expect(remaining).toBe(1);
}

async function sessionDuringResetExpired(): Promise<void> {
  const { db, alpha, ada } = harness.world;
  const member = await memberWithFactor('sol-session-cutoff');
  const reached = latch();
  const resume = latch();
  const paused: Database = {
    log: db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await db.app.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters = []) => {
              if (sql.includes('insert into ops.ended_subject_sessions')) {
                reached.open();
                await resume.promise;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
  const pending = executeCommand(paused, alpha, ada.presented, 'api', {
    command: 'access.reset_factor',
    operationId: randomUUID(),
    holderId: member.person.personId,
  });
  await reached.promise;
  let token: string;
  try {
    // The provider can create a session while the reset's local writes are
    // uncommitted. It has not yet been served by this application.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2100);
    });
    token = await sessionToken(member.person.presented.subject, { signedInAt: nowSeconds() });
  } finally {
    resume.open();
  }
  expect(isCommandRefusal(await pending)).toBe(false);
  expect(await served(token)).toEqual({ status: 401, code: 'AUTH_SESSION_EXPIRED' });
}

async function sessionRevocationDeclared(): Promise<void> {
  const member = await memberWithFactor('sol-effects');
  const before = await fingerprint(harness.world.db.admin);
  expect((await reset(apiWith(), member.person.personId)).code).toBe('ok');
  const written = changed(before, await fingerprint(harness.world.db.admin));
  expect(written).toContain('ops.ended_provider_sessions');
  expect(undeclared('access.reset_factor', written)).toEqual([]);
}

/**
 * A reset by `caller` of `target`, paused at its access lock, after the
 * envelope has admitted the caller. `meanwhile` runs on the owner's
 * connection while it waits; the answer is the reset's.
 */
async function resetAcrossLock(
  caller: Member,
  target: Member,
  meanwhile: () => Promise<void>,
): Promise<string> {
  const { db, alpha } = harness.world;
  const reached = latch();
  const resume = latch();
  const paused: Database = {
    log: db.app.log,
    close: async () => {},
    withBusiness: async (businessId, run) =>
      await db.app.withBusiness(
        businessId,
        async (tx) =>
          await run({
            ...tx,
            query: async (sql, parameters = []) => {
              if (sql.includes('pg_advisory_xact_lock') && parameters[0] === `access:${alpha}`) {
                reached.open();
                await resume.promise;
              }
              return await tx.query(sql, parameters);
            },
          }),
      ),
  };
  const pending = executeCommand(paused, alpha, caller.presented, 'api', {
    command: 'access.reset_factor',
    operationId: randomUUID(),
    holderId: target.personId,
  });
  await reached.promise;
  try {
    await meanwhile();
  } finally {
    resume.open();
  }
  const answer = await pending;
  return isCommandRefusal(answer) ? answer.code : 'ok';
}

/** The grant lapses now: after the waiting transaction began, before its lock. */
const lapse = async (grantId: string): Promise<void> => {
  await harness.world.db.admin.execute(
    'update public.grants set expires_at = clock_timestamp() where id = $1',
    [grantId],
  );
};

/**
 * The same race as `revokedBeforeLockRefused`, by the clock: the caller's
 * settings grant lapses while the reset waits for the access lock, with
 * nobody revoking it, so the reset refuses and writes nothing.
 */
async function expiredBeforeLockRefused(): Promise<void> {
  const { db, alpha } = harness.world;
  const caller = await enrol(db.app, alpha, 'reset-lapsing-caller');
  const target = await enrol(db.app, alpha, 'reset-lapsing-target');
  await withFactor(target);
  const grantId = await db.app.withBusiness(
    alpha,
    async (tx) => await grantTo(tx, caller, 'manage', WHOLE_BUSINESS, false, 'settings'),
  );
  const before = await resetState(target);
  expect(await resetAcrossLock(caller, target, async () => await lapse(grantId))).toBe(
    'SCOPE_NOT_GRANTED',
  );
  expect(await resetState(target)).toEqual(before);
}

/**
 * The rank (ORCH66-FACTORM2) on the same clock: the target holds a
 * business-wide key the caller's own copy of lapses during the wait, so under
 * the lock the caller no longer holds every key the target holds.
 */
async function rankLapsedBeforeLockRefused(): Promise<void> {
  const { db, alpha } = harness.world;
  const caller = await enrol(db.app, alpha, 'reset-ranking-caller');
  const target = await enrol(db.app, alpha, 'reset-ranking-target');
  await withFactor(target);
  const callerRead = await db.app.withBusiness(alpha, async (tx) => {
    await grantTo(tx, caller, 'manage', WHOLE_BUSINESS, false, 'settings');
    await grantTo(tx, target, 'read', WHOLE_BUSINESS);
    return await grantTo(tx, caller, 'read', WHOLE_BUSINESS);
  });
  const before = await resetState(target);
  expect(await resetAcrossLock(caller, target, async () => await lapse(callerRead))).toBe(
    'FACTOR_RESET_REFUSED',
  );
  expect(await resetState(target)).toEqual(before);
}

describe.skipIf(serverUrl === undefined)(
  'C59 factor reset: what the reset commits and what stays owed',
  () => {
    it(
      'a settings grant revoked before the reset acquires its access lock prevents the write',
      revokedBeforeLockRefused,
    );
    it(
      'a reset still within its failed attempt claim is counted as owed by the retry pass',
      claimedResetCountedOwed,
    );
    it(
      'a session signed in during the reset transaction is expired after the reset commits',
      sessionDuringResetExpired,
    );
    it(
      'the reset effect declaration covers the session revocation path its positive recipe omits',
      sessionRevocationDeclared,
    );
    it(
      'a settings grant that expires while the reset waits for its access lock prevents the write',
      expiredBeforeLockRefused,
    );
    it(
      'a business-wide key of the caller that expires while the reset waits no longer counts toward its rank',
      rankLapsedBeforeLockRefused,
    );
  },
);
