// SPDX-License-Identifier: AGPL-3.0-only
//
// A reset takes a place in the installation's reset room before its token is
// spent: open, unsettled windows (`ops.subject_resets`) fewer than the lower of
// `auth.update_user_password`'s concurrency and its route's ceiling. A full
// room answers RESET_UNAVAILABLE with the token live and no window opened; the
// token's life is judged after the room's wait, never before it.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, expect, it, vi } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/commands/account-password.ts';
import { AUTH_UPDATE_USER_PASSWORD, catalogue } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { hold, latch, waiterOf } from '../support/lock-wait-race.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  broker,
  freshMember,
  mintToken,
  usePasswordWorld,
  world,
} from './c40-password-set-world.ts';

/** A database is needed: without one, the file skips. */
const LIVE = it.skipIf(serverUrl === undefined);

usePasswordWorld();

/** The world's broker with the room's two limits set. */
const limited = (concurrency: number, ceiling: number): Broker => ({
  ...broker,
  operations: catalogue([{ ...AUTH_UPDATE_USER_PASSWORD, concurrency }]),
  // oxlint-disable-next-line no-map-spread -- a copy, the world's routes stay as they are
  routes: broker.routes.map((route) => ({ ...route, ceiling })),
});

const reset = async (room: Broker, token: string, password: string) =>
  await setPasswordByToken(
    world.db.app,
    [world.alpha, world.bravo],
    { broker: room },
    { token, password },
  );

const openWindows = async (): Promise<number> => {
  const [row] = await world.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from ops.subject_resets
      where settled_at is null and open_until > clock_timestamp()`,
  );
  return row?.n ?? 0;
};

/** A window some other reset holds open, by a subject no member has. */
const anotherOpenWindow = async (until = "clock_timestamp() + interval '5 minutes'") => {
  const id = randomUUID();
  await world.db.admin.execute(
    `insert into ops.subject_resets (id, subject_digest, open_until)
     values ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), ${until})`,
    [id, randomUUID()],
  );
  return id;
};

const settle = async (id: string): Promise<void> => {
  await world.db.admin.execute('update ops.subject_resets set settled_at = now() where id = $1', [
    id,
  ]);
};

const spent = async (token: string): Promise<boolean> => {
  const [row] = await world.db.admin.execute<{ spent: boolean }>(
    `select spent_at is not null as spent from public.password_reset_tokens
      where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [token],
  );
  return row?.spent ?? false;
};

beforeEach(async () => {
  if (serverUrl === undefined) return;
  // Every window an earlier case left open settles, so each case starts with an empty room.
  await world.db.admin.execute(
    `update ops.subject_resets set settled_at = now()
      where settled_at is null and open_until > clock_timestamp()`,
  );
});

LIVE(
  'a full room refuses a reset before its token is spent, and a settled window frees it',
  async () => {
    const member = await freshMember('room-full');
    const token = await mintToken(member.presented.subject);
    const other = await anotherOpenWindow();
    const dispatch = vi.spyOn(broker.custody, 'dispatch');
    try {
      const refused = await reset(limited(1, 4), token, 'a full room password');
      expect({
        refused,
        spent: await spent(token),
        open: await openWindows(),
        calls: dispatch.mock.calls.length,
      }).toEqual({
        refused: { ok: false, code: 'RESET_UNAVAILABLE' },
        spent: false,
        open: 1,
        calls: 0,
      });
    } finally {
      dispatch.mockRestore();
    }
    await settle(other);
    expect(await reset(limited(1, 4), token, 'a full room password')).toEqual({ ok: true });
  },
);

LIVE('a lapsed or settled window takes no room', async () => {
  const member = await freshMember('room-lapsed');
  const token = await mintToken(member.presented.subject);
  await anotherOpenWindow("clock_timestamp() - interval '1 second'");
  await settle(await anotherOpenWindow());
  expect(await reset(limited(1, 4), token, 'a lapsed window password')).toEqual({ ok: true });
});

LIVE('a route ceiling lower than the concurrency binds the room', async () => {
  const member = await freshMember('room-ceiling');
  const token = await mintToken(member.presented.subject);
  await anotherOpenWindow();
  expect(await reset(limited(4, 1), token, 'a ceiling bound password')).toEqual({
    ok: false,
    code: 'RESET_UNAVAILABLE',
  });
  expect(await spent(token)).toBe(false);
});

LIVE(
  'a token that expires while its reset waits for the room is not spent after the wait',
  async () => {
    const member = await freshMember('room-expiry');
    const token = await mintToken(member.presented.subject);
    const room = await hold(world.db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'reset_dispatch_room',
      ]);
    });
    let pending: ReturnType<typeof reset> | undefined;
    try {
      await world.db.admin.execute(
        `update public.password_reset_tokens set expires_at = clock_timestamp() + interval '2 seconds'
        where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
        [token],
      );
      pending = reset(limited(4, 4), token, 'an expiring token password');
      await waiterOf(world.db, room);
      await delay(2500);
    } finally {
      await room.letGo();
    }
    expect({ answer: await pending, spent: await spent(token), open: await openWindows() }).toEqual(
      {
        answer: { ok: false, code: 'RESET_LINK_INVALID' },
        spent: false,
        open: 0,
      },
    );
  },
);

LIVE(
  'a reset with its provider answer still out keeps its window counted against the next',
  async () => {
    const first = await freshMember('room-first');
    const second = await freshMember('room-second');
    const firstToken = await mintToken(first.presented.subject);
    const secondToken = await mintToken(second.presented.subject);
    const room = limited(1, 4);
    const original = broker.custody.dispatch.bind(broker.custody);
    const released = latch();
    const reached = latch();
    const letGo = () => released.open();
    const held = vi.spyOn(broker.custody, 'dispatch').mockImplementation(async (...args) => {
      reached.open();
      await released.promise;
      return await original(...args);
    });
    try {
      const firstAnswer = reset(room, firstToken, 'the first reset password');
      await reached.promise;
      const secondAnswer = await reset(room, secondToken, 'the second reset password');
      expect({ secondAnswer, spent: await spent(secondToken) }).toEqual({
        secondAnswer: { ok: false, code: 'RESET_UNAVAILABLE' },
        spent: false,
      });
      letGo();
      expect(await firstAnswer).toEqual({ ok: true });
    } finally {
      letGo();
      held.mockRestore();
    }
    expect(await reset(room, secondToken, 'the second reset password')).toEqual({ ok: true });
  },
);

LIVE(
  'a reset whose process dies after its spend keeps its place in the room until its window lapses',
  async () => {
    const dead = await freshMember('room-crash-dead');
    const next = await freshMember('room-crash-next');
    const deadToken = await mintToken(dead.presented.subject);
    const nextToken = await mintToken(next.presented.subject);
    const room = limited(1, 4);
    const reached = latch();
    // The other process dies at its dispatch: its spend has committed, and nothing after it runs.
    // Its custody is its own, so its place with the provider is not this process's.
    const dying: Broker = {
      ...room,
      custody: Object.assign(Object.create(broker.custody) as Broker['custody'], {
        dispatch: async () => {
          reached.open();
          return await new Promise<never>(() => {
            // Never answers: the process is gone.
          });
        },
      }),
    };
    void reset(dying, deadToken, 'the dead reset password');
    await reached.promise;
    expect({
      next: await reset(room, nextToken, 'the next reset password'),
      nextSpent: await spent(nextToken),
      retry: await reset(room, deadToken, 'the dead reset password'),
    }).toEqual({
      next: { ok: false, code: 'RESET_UNAVAILABLE' },
      nextSpent: false,
      retry: { ok: false, code: 'RESET_LINK_INVALID' },
    });
    // The dead window's five minutes pass: its end moves into the past, as no settle ever comes.
    await world.db.admin.execute(
      `do $$ begin
         set local session_replication_role = replica;
         update ops.subject_resets set open_until = clock_timestamp() - interval '1 second'
          where subject_digest = encode(sha256(convert_to('${dead.presented.subject}', 'UTF8')), 'hex')
            and settled_at is null;
       end $$`,
    );
    expect(await reset(room, nextToken, 'the next reset password')).toEqual({ ok: true });
  },
);
