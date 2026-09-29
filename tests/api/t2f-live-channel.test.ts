// SPDX-License-Identifier: AGPL-3.0-only
//
// T2f, the live task channel, against a real database.
//
// A write to a task emits a content-free invalidation from inside its own
// transaction; the API listens on one listen-only session connection and fans
// each payload out by the business it names, never by anything the caller
// sent; the event route joins through the same door as every other route and
// asks `task.read` whether this caller may see the task, at join and again
// before every delivery. These cases hold each of those against the real
// migration, the real listener and the real composition root.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  connect,
  connectListener,
  type Database,
  type Listener,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics, type LiveSignal } from '../../apps/api/live.ts';
import { authorised, ISSUER, SECRET, tokenFor } from './fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/t2f-live-channel: DATABASE_URL is unset, so nothing below ran.');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Poll `check` until it holds or `ms` pass; the elapsed time when it held. */
async function within(ms: number, check: () => boolean, what: string): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
  return Date.now() - started;
}

interface Joined {
  readonly status: number;
  readonly refusal: Record<string, unknown>;
  readonly events: string[];
  ended: boolean;
  stop(): Promise<void>;
}

/** Open the task's stream and record each event name as it arrives. */
async function join(api: Hono, key: string, recordId: string, token: string): Promise<Joined> {
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.person}${key}/live/task/${recordId}`, {
      headers: authorised(token),
    }),
  );
  const events: string[] = [];
  if (response.status !== 200 || response.body === null) {
    const text = await response.text();
    return {
      status: response.status,
      refusal: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
      events,
      ended: true,
      stop: async () => {},
    };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const joined: Joined = {
    status: 200,
    refusal: {},
    events,
    ended: false,
    stop: async () => await reader.cancel().catch(() => {}),
  };
  void (async () => {
    let buffer = '';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
        const line = buffer
          .slice(0, at)
          .split('\n')
          .find((l) => l.startsWith('event:'));
        if (line !== undefined) events.push(line.slice('event:'.length).trim());
        buffer = buffer.slice(at + 2);
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      joined.ended = true;
    });
  return joined;
}

const count = (events: readonly string[], name: string): number =>
  events.filter((event) => event === name).length;

// Real round trips on a shared server: each case names a bound of its own inside.
describe.skipIf(serverUrl === undefined)(
  'T2f the live task channel on a real database',
  { timeout: 30_000 },
  () => {
    let s: Schedules;
    let key: string;
    let pool: Database;
    let listener: Listener;
    let topics: LiveTopics;
    let api: Hono;
    const opened: Joined[] = [];

    const open = async (recordId: string, who: Member, token?: string): Promise<Joined> => {
      const joined = await join(
        api,
        key,
        recordId,
        token ?? (await tokenFor(who.presented.subject)),
      );
      opened.push(joined);
      return joined;
    };

    /** A write the records trigger sees, under `business`, on `pool`. */
    const touch = async (business: string, recordId: string): Promise<void> => {
      await pool.withBusiness(business, async (tx) => {
        await tx.query('update public.records set data = data where id = $1', [recordId]);
      });
    };

    beforeAll(async () => {
      s = await openSchedules('t2f', 1_000_000);
      const rows = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [s.business],
      );
      key = String(rows[0]?.key);
      // More than one connection, so the pooling proofs are about a pool.
      pool = connect(s.db.appUrl, { max: 4 });
      listener = connectListener(s.db.appUrl);
      topics = await startLiveTopics(listener);
      api = composeApi({
        database: pool,
        admin: s.db.admin,
        secret: SECRET,
        issuer: ISSUER,
        keys: runtimeKeys({ ...process.env }),
        live: { topics, recheckMs: 200 },
      }).app;
    }, 180_000);

    afterAll(async () => {
      await Promise.allSettled(opened.map(async (joined) => await joined.stop()));
      await topics?.close();
      await pool?.close();
      await s?.db.drop();
    });

    it('event_visible_under_2s: a worker event reaches an already-open task page within two seconds, and a viewer without the grant is refused at join', async () => {
      const taskId = await createTask(s, `t2f-visible-${randomUUID()}`);
      const proposal = await propose(s, taskId, { maximumMinor: 1_000, purpose: freshPurpose() });
      const decision = await approve(s, proposal);

      const page = await open(taskId, s.decider);
      expect(page.status).toBe(200);
      await within(2_000, () => count(page.events, 'resync') === 1, 'resync on connect');
      const before = count(page.events, 'invalidate');

      // The worker's pickup writes the `claimed` run event (T2a).
      await pickup(s, decision['reservationId']);
      const elapsed = await within(
        2_000,
        () => count(page.events, 'invalidate') > before,
        'the claimed event on the open page',
      );
      expect(elapsed).toBeLessThan(2_000);

      const stranger = await enrol(s.db.app, s.business, `t2f-stranger-${randomUUID()}`);
      const refused = await open(taskId, stranger);
      expect(refused.status).not.toBe(200);
      expect(refused.refusal).toMatchObject({ refused: true });
    });

    it('T2f rollback: a rolled-back transaction, a rolled-back savepoint and a write row security refuses deliver nothing; a committed control arrives', async () => {
      const taskId = await createTask(s, `t2f-rollback-${randomUUID()}`);
      const heard: LiveSignal[] = [];
      const unsubscribe = topics.subscribe(s.business, taskId, (signal) => heard.push(signal));
      const other = await cq8World(s).party(`t2f-rls-${randomUUID().slice(0, 8)}`);
      // A committed barrier on another task: delivery follows commit order, so
      // once it is heard this task's own creation has been too.
      const mark = await createTask(s, `t2f-mark-${randomUUID()}`);
      let marked = false;
      const unmark = topics.subscribe(s.business, mark, () => (marked = true));
      await touch(s.business, mark);
      await within(2_000, () => marked, 'the barrier');
      unmark();
      heard.length = 0;

      await expect(
        pool.withBusiness(s.business, async (tx) => {
          await tx.query('update public.records set data = data where id = $1', [taskId]);
          throw new Error('roll the whole transaction back');
        }),
      ).rejects.toThrow('roll the whole transaction back');

      await pool.withBusiness(s.business, async (tx) => {
        await tx.query('savepoint t2f');
        await tx.query('update public.records set data = data where id = $1', [taskId]);
        await tx.query('rollback to savepoint t2f');
      });

      // This business's row, written under another business's tenancy.
      await expect(
        pool.withBusiness(other.id, async (tx) => {
          await tx.query(
            `insert into public.run_events
             (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
           values ($1, $2, $2, $3, 1, 'claimed', $2, $2, $2, '{}')`,
            [s.business, randomUUID(), taskId],
          );
        }),
      ).rejects.toThrow(/row-level security/u);

      await touch(s.business, taskId);
      await within(2_000, () => heard.length > 0, 'the committed control');
      await sleep(200);
      // NOTIFY is delivered in commit order, so anything the three had sent
      // would have arrived before the control.
      expect(heard).toEqual(['invalidate']);
      unsubscribe();
    });

    it('T2 isolation (T2f): interleaved writes on a pooled connection reach only their own business, and join refuses another business, another client and a person without the grant', async () => {
      const world = cq8World(s);
      const other = await world.party(`t2f-other-${randomUUID().slice(0, 8)}`);
      const [otherTask] = other.tasks;
      if (otherTask === undefined) throw new Error('party: two tasks');
      const mine = await createTask(s, `t2f-isolation-${randomUUID()}`);

      const heard = { mine: 0, theirs: 0, forged: 0, forgedBack: 0 };
      const off = [
        topics.subscribe(s.business, mine, () => (heard.mine += 1)),
        topics.subscribe(other.id, otherTask.id, () => (heard.theirs += 1)),
        // A subscriber under one business naming the other business's task.
        topics.subscribe(other.id, mine, () => (heard.forged += 1)),
        topics.subscribe(s.business, otherTask.id, () => (heard.forgedBack += 1)),
      ];
      await Promise.all(
        Array.from({ length: 40 }, async (_, n) =>
          n % 2 === 0 ? await touch(s.business, mine) : await touch(other.id, otherTask.id),
        ),
      );
      await within(3_000, () => heard.mine > 0 && heard.theirs > 0, 'both businesses heard');
      await sleep(300);
      expect(heard.forged).toBe(0);
      expect(heard.forgedBack).toBe(0);
      for (const unsubscribe of off) unsubscribe();

      // At join: the other business's member names this task, under either key.
      const foreignToken = await tokenFor(other.member.presented.subject);
      expect((await join(api, key, mine, foreignToken)).status).not.toBe(200);
      const [otherRow] = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [other.id],
      );
      const otherKey = String(otherRow?.key);
      expect((await join(api, otherKey, mine, foreignToken)).status).not.toBe(200);

      // Two clients here, one grant each: each joins its own task and is
      // refused the other's.
      const sibling = await createTask(s, `t2f-sibling-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
      const first = await world.client(s.business, s.decider, 't2f-client-1', mine);
      const second = await world.client(s.business, s.decider, 't2f-client-2', sibling);
      expect((await open(mine, first)).status).toBe(200);
      expect((await open(sibling, first)).status).not.toBe(200);
      expect((await open(mine, second)).status).not.toBe(200);
      const outsider = await enrol(s.db.app, s.business, `t2f-no-grant-${randomUUID()}`);
      expect((await open(mine, outsider)).status).not.toBe(200);
    });

    it('Sol proof, criterion 3: an external shared reader cannot join the internal activity channel', async () => {
      const taskId = await createTask(s, `t2f-external-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
      const external = await cq8World(s).client(s.business, s.decider, 't2f-external', taskId);
      const read = await cq8World(s).read(s.business, external, {
        read: 'task.read',
        recordId: taskId,
      });
      expect(read).toHaveProperty('sharedTask');

      const joined = await open(taskId, external);
      expect(joined.status).not.toBe(200);
    });

    it('T2f revoked: a stream is closed when its grant is revoked and when its session expires, and delivers nothing after', async () => {
      const taskId = await createTask(s, `t2f-revoked-${randomUUID()}`);
      const narrow = await enrol(s.db.app, s.business, `t2f-narrow-${randomUUID()}`);
      const grantId = await s.db.app.withBusiness(
        s.business,
        async (tx) => await grantTo(tx, narrow, 'read', { kind: 'record', id: taskId }),
      );
      const page = await open(taskId, narrow);
      expect(page.status).toBe(200);
      await within(2_000, () => count(page.events, 'resync') === 1, 'resync on connect');

      await s.db.admin.execute(
        'update public.grants set revoked_at = now() where business_id = $1 and id = $2',
        [s.business, grantId],
      );
      await touch(s.business, taskId);
      await within(2_000, () => page.ended, 'the revoked stream closed');
      expect(page.events.at(-1)).toBe('closed');
      expect(count(page.events, 'invalidate')).toBe(0);
      expect((await open(taskId, narrow)).status).not.toBe(200);

      const brief = await open(
        taskId,
        s.decider,
        await tokenFor(s.decider.presented.subject, { expiresIn: 1 }),
      );
      expect(brief.status).toBe(200);
      await within(4_000, () => brief.ended, 'the expired session closed');
      expect(brief.events.at(-1)).toBe('closed');
    });

    it('T2f resync: the stream resyncs on connect and again after the listener re-listens', async () => {
      const taskId = await createTask(s, `t2f-relisten-${randomUUID()}`);
      const page = await open(taskId, s.decider);
      await within(2_000, () => count(page.events, 'resync') === 1, 'resync on connect');

      await s.db.admin.execute(
        `select pg_terminate_backend(pid) from pg_stat_activity
        where datname = current_database() and query ilike 'listen %'`,
      );
      await within(5_000, () => count(page.events, 'resync') === 2, 'resync after re-listen');
      expect(topics.listening).toBe(true);
      const before = count(page.events, 'invalidate');
      await touch(s.business, taskId);
      await within(2_000, () => count(page.events, 'invalidate') > before, 'listening again');
    });

    it('T2f health: /api/health reports the listener and the notification queue usage', async () => {
      const response = await api.fetch(new Request('http://api.test/api/health'));
      const body = (await response.json()) as Record<string, unknown>;
      expect(body['live']).toBe('listening');
      expect(typeof body['notificationQueue']).toBe('number');
    });

    it('T2f listen only: the listener connection can only listen, and sends nothing but LISTEN', () => {
      expect(Object.keys(listener).toSorted()).toEqual(['close', 'listen', 'log']);
      const sent = listener.log.entries.map((entry) => entry.kind);
      expect(sent.length).toBeGreaterThan(0);
      expect(new Set(sent)).toEqual(new Set(['session']));
      expect(listener.log.schemaChanging()).toEqual([]);
    });
  },
);
