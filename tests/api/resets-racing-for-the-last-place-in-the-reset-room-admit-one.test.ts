// SPDX-License-Identifier: AGPL-3.0-only
//
// Two resets on two connections race for the reset room's last place. The
// first holds the room's key from its count to its commit, so the second waits
// behind it and counts only after that wait: it sees the first's window when
// the first commits, and the first's place when the first dies before it
// commits. A window that lapses during the wait is no longer counted. A reset
// retried after its answer was lost opens no second window and sends nothing.

import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { setPasswordByToken } from '../../packages/core-commands/src/commands/account-password.ts';
import { AUTH_UPDATE_USER_PASSWORD, catalogue } from '../../packages/core-connectors/src/index.ts';
import type { Broker } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  hold,
  instantOf,
  latch,
  waiterOf,
  waitPast,
  type Held,
} from '../support/lock-wait-race.ts';
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

/** The world's broker with a room of one place. */
const roomOfOne = (): Broker => ({
  ...broker,
  operations: catalogue([{ ...AUTH_UPDATE_USER_PASSWORD, concurrency: 1 }]),
});

const reset = async (database: Database, token: string, password: string) =>
  await setPasswordByToken(
    database,
    [world.alpha, world.bravo],
    { broker: roomOfOne() },
    { token, password },
  );

const spent = async (token: string): Promise<boolean> => {
  const [row] = await world.db.admin.execute<{ spent: boolean }>(
    `select spent_at is not null as spent from public.password_reset_tokens
      where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [token],
  );
  return row?.spent ?? false;
};

/** The subject's windows, every one ever opened. */
const windowsOf = async (subject: string): Promise<number> => {
  const [row] = await world.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from ops.subject_resets
      where subject_digest = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
    [subject],
  );
  return row?.n ?? 0;
};

/**
 * A second application pool, its own connection, whose reset stops in its
 * spend's transaction once the window is open and before the commit: the
 * room's key, the token's spend and the window's insert are all held there.
 */
function stoppedBeforeCommit() {
  const inner = connect(world.db.appUrl);
  const stopped = latch<Held>();
  const resume = latch();
  const database: Database = {
    ...inner,
    withBusiness: async (business, run) =>
      await inner.withBusiness(business, async (tx) => {
        const query = async <Row>(text: string, parameters?: readonly unknown[]) => {
          const rows = await tx.query<Row>(text, parameters);
          if (!text.includes('left_ms')) return rows;
          const [me] = await tx.query<{ pid: number }>('select pg_backend_pid() as pid');
          stopped.open({ pid: Number(me?.pid), letGo: async () => await resume.promise });
          await resume.promise;
          return rows;
        };
        return await run({ ...tx, query });
      }),
    close: async () => await inner.close(),
  };
  return { database, stopped: stopped.promise, resume: () => resume.open() };
}

beforeEach(async () => {
  if (serverUrl === undefined) return;
  // Every window an earlier case left open settles, so each case starts with an empty room.
  await world.db.admin.execute(
    `update ops.subject_resets set settled_at = now()
      where settled_at is null and open_until > clock_timestamp()`,
  );
});

LIVE(
  'of two resets racing for the last place, the one waiting behind the other is refused with its token live',
  async () => {
    const first = await freshMember('race-first');
    const second = await freshMember('race-second');
    const firstToken = await mintToken(first.presented.subject);
    const secondToken = await mintToken(second.presented.subject);
    const own = stoppedBeforeCommit();
    const original = broker.custody.dispatch.bind(broker.custody);
    const released = latch();
    const dispatch = vi.spyOn(broker.custody, 'dispatch').mockImplementation(async (...args) => {
      await released.promise;
      return await original(...args);
    });
    try {
      const firstAnswer = reset(own.database, firstToken, 'the first racer password');
      const holder = await own.stopped;
      const secondAnswer = reset(world.db.app, secondToken, 'the second racer password');
      // The second is seen waiting on the first's room key, never assumed to be after a sleep.
      await waiterOf(world.db, holder);
      own.resume();
      expect({ second: await secondAnswer, secondSpent: await spent(secondToken) }).toEqual({
        second: { ok: false, code: 'RESET_UNAVAILABLE' },
        secondSpent: false,
      });
      released.open();
      expect(await firstAnswer).toEqual({ ok: true });
      // The first's answer is lost and the same request comes again: no window, no call.
      expect({
        retry: await reset(world.db.app, firstToken, 'the first racer password'),
        calls: dispatch.mock.calls.length,
        windows: await windowsOf(first.presented.subject),
      }).toEqual({ retry: { ok: false, code: 'RESET_LINK_INVALID' }, calls: 1, windows: 1 });
    } finally {
      own.resume();
      released.open();
      dispatch.mockRestore();
      await own.database.close();
    }
    expect(await reset(world.db.app, secondToken, 'the second racer password')).toEqual({
      ok: true,
    });
  },
  30_000,
);

LIVE(
  'a reset that dies before its spend commits leaves its token live and its place to the reset waiting behind it',
  async () => {
    const dying = await freshMember('race-dying');
    const waiting = await freshMember('race-waiting');
    const dyingToken = await mintToken(dying.presented.subject);
    const waitingToken = await mintToken(waiting.presented.subject);
    const own = stoppedBeforeCommit();
    try {
      const dyingAnswer = reset(own.database, dyingToken, 'the dying racer password');
      const holder = await own.stopped;
      const waitingAnswer = reset(world.db.app, waitingToken, 'the waiting racer password');
      await waiterOf(world.db, holder);
      // The process holding the spend goes: its connection drops before the commit.
      await world.db.admin.execute('select pg_terminate_backend($1)', [holder.pid]);
      own.resume();
      const died = await dyingAnswer.then(
        () => false,
        () => true,
      );
      expect({
        died,
        dyingSpent: await spent(dyingToken),
        dyingWindows: await windowsOf(dying.presented.subject),
        waiting: await waitingAnswer,
      }).toEqual({ died: true, dyingSpent: false, dyingWindows: 0, waiting: { ok: true } });
    } finally {
      own.resume();
      // The dead pool's end never comes back: its one connection went with the process.
      void own.database.close().catch(() => null);
    }
    // The same request again, once the waiting reset has settled: its token was never spent.
    expect(await reset(world.db.app, dyingToken, 'the dying racer password')).toEqual({ ok: true });
  },
  30_000,
);

LIVE(
  'a window that lapses while a reset waits for the room frees its place for that reset',
  async () => {
    const member = await freshMember('race-lapse');
    const token = await mintToken(member.presented.subject);
    const other = randomUUID();
    await world.db.admin.execute(
      `insert into ops.subject_resets (id, subject_digest, open_until)
     values ($1, encode(sha256(convert_to($2, 'UTF8')), 'hex'), clock_timestamp() + interval '2 seconds')`,
      [other, randomUUID()],
    );
    const lapses = await instantOf(
      world.db,
      'select open_until::text as at from ops.subject_resets where id = $1',
      [other],
    );
    const room = await hold(world.db, async (execute) => {
      await execute('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        'reset_dispatch_room',
      ]);
    });
    let pending: ReturnType<typeof reset> | undefined;
    try {
      pending = reset(world.db.app, token, 'a lapsed while waiting password');
      // It began, and judged nothing, while the other window was still open.
      await waiterOf(world.db, room);
      await waitPast(world.db, lapses);
    } finally {
      await room.letGo();
    }
    expect(await pending).toEqual({ ok: true });
  },
  30_000,
);
