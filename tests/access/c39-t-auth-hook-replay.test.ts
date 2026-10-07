// SPDX-License-Identifier: AGPL-3.0-only
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

// Pause after a real transaction commits. No query results or writes are mocked.
function pauseAfterScan(business: string): {
  database: Database;
  reached: Promise<void>;
  release: () => void;
} {
  const reached = latch();
  const released = latch();
  let paused = false;
  const database: Database = {
    log: w.db.app.log,
    close: async () => {},
    async withBusiness(id, run) {
      const answer = await w.db.app.withBusiness(id, run);
      if (id === business && !paused) {
        paused = true;
        reached.resolve();
        await released.promise;
      }
      return answer;
    },
  };
  return { database, reached: reached.promise, release: () => released.resolve() };
}

it.skipIf(noDatabase)(
  'business to business replay allows at most one send for one message across hook processes',
  async () => {
    w.provider.mode('accept');
    const address = addressFor('sol-concurrent-businesses');
    const raw = authMessage('invite', address);
    const signed = signAuth(raw, Math.floor(Date.now() / 1000));
    const second = pauseAfterScan(w.alpha);
    const first = pauseAfterScan(w.bravo);
    // B sees alpha empty. Then A sees alpha pending and bravo empty.
    const replyB = postAuth(raw, signed, undefined, route(second.database));
    await second.reached;
    let replyA: ReturnType<typeof postAuth> | undefined;
    try {
      const alpha = await invite(c.admin, address);
      replyA = postAuth(raw, signed, undefined, route(first.database));
      await first.reached;
      const bravo = await invite(c.bravoAdmin, address);
      // Both invitations now exist before either sender takes a row lock.
      second.release();
      first.release();
      await Promise.all([replyA, replyB]);
      const minted =
        (await countFor('enrolment_tokens', alpha)) + (await countFor('enrolment_tokens', bravo));
      // Whichever business wins, one signed message cannot produce two sends.
      expect(Math.max(mailTo(address).length, minted)).toBeLessThanOrEqual(1);
    } finally {
      second.release();
      first.release();
      await Promise.allSettled([replyB, ...(replyA === undefined ? [] : [replyA])]);
    }
  },
);

it.skipIf(noDatabase)(
  'an invitation expiring while the hook waits for its row lock sends no expired link',
  async () => {
    w.provider.mode('accept');
    const address = addressFor('sol-expiry-lock');
    const invitation = await invite(c.admin, address);
    const waiting = latch();
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
                if (text.includes('from invitations') && text.includes('for update'))
                  waiting.resolve();
                return await tx.query(text, parameters);
              },
            }),
        );
      },
    };
    const app = route(database);
    let reply: ReturnType<typeof postAuth> | undefined;
    await w.db.admin.transaction(async (execute) => {
      await execute('select id from public.invitations where id = $1 for update', [invitation]);
      const raw = authMessage('invite', address);
      reply = postAuth(raw, signAuth(raw, Math.floor(Date.now() / 1000)), undefined, app);
      await waiting.promise;
      // The send transaction has started and is waiting on this lock.
      await execute(
        "update public.invitations set expires_at = clock_timestamp() + interval '150 milliseconds' where id = $1",
        [invitation],
      );
      await execute('select pg_sleep(0.3)');
      const [expired] = await execute<{ expired: boolean }>(
        'select expires_at < clock_timestamp() as expired from public.invitations where id = $1',
        [invitation],
      );
      expect(expired?.expired).toBe(true);
    });
    await reply;
    expect({
      messages: mailTo(address).length,
      minted: await countFor('enrolment_tokens', invitation),
    }).toEqual({ messages: 0, minted: 0 });
  },
);
