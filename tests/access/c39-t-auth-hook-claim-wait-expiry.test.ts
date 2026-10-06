// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { mountAuthEmailHook } from '../../apps/api/auth-email-hook.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { AUTH_HOOK_SECRET, authMessage, mailTo, postAuth, signAuth } from './c39-t-hook-world.ts';
import {
  addressFor,
  c,
  countFor,
  invite,
  MAIL,
  noDatabase,
  useInvitationWorld,
  w,
} from './c39-t-world.ts';

useInvitationWorld();

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

function route(database: Database): Hono {
  const app = new Hono();
  mountAuthEmailHook(app, database, {
    secret: AUTH_HOOK_SECRET.slice(3),
    businesses: async () => await Promise.resolve([w.alpha, w.bravo]),
    broker: w.broker,
    mail: MAIL,
  });
  return app;
}

// The real database, with a signal when the send issues its claim. No query results are mocked.
function watchClaim(): { database: Database; reachedClaim: Promise<void> } {
  const reached = latch();
  const database: Database = {
    log: w.db.app.log,
    close: async () => {},
    async withBusiness(business, run) {
      return await w.db.app.withBusiness(
        business,
        async (tx) =>
          await run({
            ...tx,
            async query(text, parameters) {
              if (text.includes('insert into ops.auth_hook_messages')) reached.resolve();
              return await tx.query(text, parameters);
            },
          }),
      );
    },
  };
  return { database, reachedClaim: reached.promise };
}

/**
 * The same unique-key claim another process holds, until the send waits on it and the invitation
 * has expired; then that transaction rolls back.
 */
async function claimThenAbort(
  digest: string,
  invitation: string,
  start: () => Promise<void>,
): Promise<void> {
  const abort = new Error('the other hook transaction rolls back');
  try {
    await w.db.admin.transaction(async (execute) => {
      await execute('insert into ops.auth_hook_messages (message_digest) values ($1)', [digest]);
      await start();
      await execute('select pg_sleep(0.05)');
      const [blocked] = await execute<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'
           and query like '%insert into ops.auth_hook_messages%'`,
      );
      expect(blocked?.n).toBe(1);
      await execute('select pg_sleep(2.2)');
      const [expired] = await execute<{ expired: boolean }>(
        'select expires_at < clock_timestamp() as expired from public.invitations where id = $1',
        [invitation],
      );
      expect(expired?.expired).toBe(true);
      throw abort;
    });
  } catch (error) {
    expect(error).toBe(abort);
  }
}

it.skipIf(noDatabase)(
  'a hook claim that rolls back after the invitation expires sends no expired link',
  async () => {
    w.provider.mode('accept');
    const address = addressFor('sol-claim-expiry');
    const invitation = await invite(c.admin, address);
    const raw = authMessage('invite', address);
    const signed = signAuth(raw, Math.floor(Date.now() / 1000));
    const digest = createHash('sha256').update(signed.id).digest('hex');
    const { database, reachedClaim } = watchClaim();
    const app = route(database);
    await w.db.admin.execute(
      "update public.invitations set expires_at = clock_timestamp() + interval '2 seconds' where id = $1",
      [invitation],
    );
    let reply: ReturnType<typeof postAuth> | undefined;
    try {
      await claimThenAbort(digest, invitation, async () => {
        reply = postAuth(raw, signed, undefined, app);
        await reachedClaim;
      });
    } finally {
      await reply;
    }
    const [claim] = await w.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from ops.auth_hook_messages where message_digest = $1',
      [digest],
    );
    expect({
      messages: mailTo(address).length,
      minted: await countFor('enrolment_tokens', invitation),
      attempts: await countFor('invitation_delivery_attempts', invitation),
      claims: claim?.n,
    }).toEqual({ messages: 0, minted: 0, attempts: 0, claims: 0 });
  },
);
