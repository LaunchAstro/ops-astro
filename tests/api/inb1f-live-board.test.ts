// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1f, the board moves live, against a real database and the real
// composition root.
//
// One event stream per tab carries every topic (browsers allow about six
// HTTP/1.1 connections per origin): `GET <person prefix><business>/live`.
// It is T2f's content-free channel, joined through the same door: `resync` on
// connect, then `invalidate` naming a task (its identifier, never its
// content) when a task the caller may read is added, moved or completed, or
// its agent work moves, and `inbox` when the caller's own inbox changes. A
// task the caller cannot read, another business's, and another person's inbox
// never produce an event on it. The inbox signal is sent on commit, so the
// count drops with the deciding transaction and never before it.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  connect,
  connectListener,
  type Database,
  type Listener,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { DELEGATION_HEADER, PREFIX } from '../../packages/core-wire/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { authorised, ISSUER, SECRET, tokenFor } from './fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  revisionOf,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/inb1f-live-board: DATABASE_URL is unset, so nothing below ran.');
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function within(ms: number, check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}

interface Heard {
  readonly event: string;
  readonly data: string;
}

interface Tab {
  readonly status: number;
  readonly body: string;
  readonly heard: Heard[];
  ended: boolean;
  stop(): Promise<void>;
}

/** Open one tab's stream at `path` and record each event and its data. */
async function openTab(api: Hono, path: string, headers: Record<string, string>): Promise<Tab> {
  const response = await api.fetch(new Request(`http://api.test${path}`, { headers }));
  const heard: Heard[] = [];
  if (response.status !== 200 || response.body === null) {
    return {
      status: response.status,
      body: await response.text(),
      heard,
      ended: true,
      stop: async () => {},
    };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const tab: Tab = {
    status: 200,
    body: '',
    heard,
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
        const lines = buffer.slice(0, at).split('\n');
        const field = (name: string) =>
          lines
            .find((line) => line.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        const event = field('event');
        if (event !== undefined) heard.push({ event, data: field('data') ?? '' });
        buffer = buffer.slice(at + 2);
      }
    }
  })()
    .catch(() => {})
    .finally(() => {
      tab.ended = true;
    });
  return tab;
}

const named = (tab: Tab, taskId: string): number =>
  tab.heard.filter((one) => one.event === 'invalidate' && one.data === taskId).length;
const inboxSignals = (tab: Tab): number => tab.heard.filter((one) => one.event === 'inbox').length;

describe.skipIf(serverUrl === undefined)(
  'INB-1f the board moves live on one stream per tab',
  { timeout: 30_000 },
  () => {
    let s: Schedules;
    let key: string;
    let pool: Database;
    let listener: Listener;
    let topics: LiveTopics;
    let api: Hono;
    const opened: Tab[] = [];

    const tabOf = async (who: Member, token?: string, businessKey = key): Promise<Tab> => {
      const tab = await openTab(
        api,
        `${PREFIX.person}${businessKey}/live`,
        authorised(token ?? (await tokenFor(who.presented.subject))),
      );
      opened.push(tab);
      return tab;
    };

    const joined = async (tab: Tab): Promise<void> => {
      expect(tab.status, tab.body).toBe(200);
      await within(2_000, () => tab.heard.some((one) => one.event === 'resync'), 'resync');
    };

    /** A committed write on `barrier` that `tab` hears: everything before it has arrived. */
    const settled = async (tab: Tab, barrier: string): Promise<void> => {
      const before = named(tab, barrier);
      await pool.withBusiness(s.business, async (tx) => {
        await tx.query('update public.records set data = data where id = $1', [barrier]);
      });
      await within(2_000, () => named(tab, barrier) > before, 'the barrier');
      await sleep(200);
    };

    beforeAll(async () => {
      s = await openSchedules('inb1f', 1_000_000);
      const rows = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [s.business],
      );
      key = String(rows[0]?.key);
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
      await Promise.allSettled(opened.map(async (tab) => await tab.stop()));
      await topics?.close();
      await pool?.close();
      await s?.db.drop();
    });

    it('INB-1 board live: a task added, moved and completed, and its agent work, reach an open tab within two seconds', async () => {
      const tab = await tabOf(s.decider);
      await joined(tab);

      const taskId = await createTask(s, `inb1f-added-${randomUUID()}`);
      await within(2_000, () => named(tab, taskId) > 0, 'the added task');

      const board = await createTask(s, `inb1f-board-${randomUUID()}`);
      let seen = named(tab, taskId);
      appliedDetail(
        await asPerson(s, {
          command: 'task.move',
          operationId: randomUUID(),
          recordId: taskId,
          expectedRevision: await revisionOf(s, taskId),
          board,
          boardSection: null,
        }),
        'task.move',
      );
      await within(2_000, () => named(tab, taskId) > seen, 'the moved task');

      seen = named(tab, taskId);
      appliedDetail(
        await asPerson(s, {
          command: 'task.complete',
          operationId: randomUUID(),
          recordId: taskId,
          expectedRevision: await revisionOf(s, taskId),
        }),
        'task.complete',
      );
      await within(2_000, () => named(tab, taskId) > seen, 'the completed task');

      // Agent activity: the worker's pickup writes the run's `claimed` event.
      const worked = await createTask(s, `inb1f-agent-${randomUUID()}`);
      const decision = await approve(
        s,
        await propose(s, worked, { maximumMinor: 1_000, purpose: freshPurpose() }),
      );
      seen = named(tab, worked);
      await pickup(s, decision['reservationId']);
      await within(2_000, () => named(tab, worked) > seen, 'the agent’s pickup');
    });

    it('INB-1 isolation (the live board stream): another business, another client and a person under a live delegation hear nothing and are refused', async () => {
      const world = cq8World(s);
      const mine = await createTask(s, `inb1f-mine-${randomUUID()}`);
      const hidden = await createTask(s, `inb1f-hidden-${randomUUID()}`);

      // A person here who reads exactly one task: the other never reaches them.
      const narrow = await enrol(s.db.app, s.business, `inb1f-narrow-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, narrow, 'read', { kind: 'record', id: mine });
      });
      const narrowTab = await tabOf(narrow);
      await joined(narrowTab);

      // Another business, writing its own task while both tabs are open.
      const other = await world.party(`inb1f-other-${randomUUID().slice(0, 8)}`);
      const [otherTask] = other.tasks;
      if (otherTask === undefined) throw new Error('party: two tasks');
      const [otherRow] = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [other.id],
      );
      const otherTab = await tabOf(other.member, undefined, String(otherRow?.key));
      await joined(otherTab);

      const wholeTab = await tabOf(s.decider);
      await joined(wholeTab);
      await Promise.all(
        Array.from({ length: 12 }, async (_, n) => {
          const [business, id] =
            n % 3 === 0
              ? [s.business, hidden]
              : n % 3 === 1
                ? [other.id, otherTask.id]
                : [s.business, mine];
          await pool.withBusiness(business, async (tx) => {
            await tx.query('update public.records set data = data where id = $1', [id]);
          });
        }),
      );
      await settled(wholeTab, mine);
      await within(2_000, () => named(narrowTab, mine) > 0, 'the narrow tab hears its task');
      await within(
        2_000,
        () => named(otherTab, otherTask.id) > 0,
        'the other business hears its own',
      );

      // Not a count, not an identifier: nothing of the hidden task or the
      // other business reaches a tab that cannot read it.
      expect(named(narrowTab, hidden)).toBe(0);
      expect(JSON.stringify(narrowTab.heard)).not.toContain(hidden);
      expect(JSON.stringify(narrowTab.heard)).not.toContain(otherTask.id);
      expect(JSON.stringify(wholeTab.heard)).not.toContain(otherTask.id);
      expect(JSON.stringify(otherTab.heard)).not.toContain(mine);
      expect(JSON.stringify(otherTab.heard)).not.toContain(hidden);

      // The other business's member under this business's key: refused.
      const foreign = await tabOf(other.member, await tokenFor(other.member.presented.subject));
      expect(foreign.status).not.toBe(200);
      expect(foreign.body).not.toContain(mine);

      // Another client here, holding a share of one task: an external reader
      // stays off the internal channel entirely (T2f, Sol on #111).
      await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
      const client = await world.client(
        s.business,
        s.decider,
        `inb1f-client-${randomUUID()}`,
        mine,
      );
      const clientTab = await tabOf(client);
      expect(clientTab.status).not.toBe(200);
      expect(clientTab.body).not.toContain(hidden);

      // A person under a live delegation: the agent's credential opens no tab,
      // on the person path or the agent path.
      const decision = await approve(
        s,
        await propose(s, mine, { maximumMinor: 1_000, purpose: freshPurpose() }),
      );
      const credential = String((await pickup(s, decision['reservationId']))['credential']);
      const agentToken = await tokenFor(s.agent.subject);
      for (const prefix of [PREFIX.person, PREFIX.agent]) {
        // eslint-disable-next-line no-await-in-loop
        const delegated = await openTab(api, `${prefix}${key}/live`, {
          ...authorised(agentToken),
          [DELEGATION_HEADER]: credential,
        });
        opened.push(delegated);
        expect(delegated.status, prefix).not.toBe(200);
        expect(delegated.body, prefix).not.toContain(hidden);
      }
    });

    it('INB-1 the owed count moves live: the same tab hears its own inbox on the deciding commit, never another person’s', async () => {
      const taskId = await createTask(s, `inb1f-inbox-${randomUUID()}`);
      const reviewer = await enrol(s.db.app, s.business, `inb1f-reviewer-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => {
        for (const action of ['read', 'decide'] as const) {
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, reviewer, action, { kind: 'record', id: taskId });
        }
      });
      const bystander = await enrol(s.db.app, s.business, `inb1f-bystander-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, bystander, 'read', { kind: 'record', id: taskId });
      });
      const tab = await tabOf(reviewer);
      const quiet = await tabOf(bystander);
      await joined(tab);
      await joined(quiet);

      // Raised: the proposal gives the reviewer a decision item.
      const proposal = await propose(s, taskId, { maximumMinor: 1_000, purpose: freshPurpose() });
      await within(2_000, () => inboxSignals(tab) > 0, 'the raised item');
      // One stream carries both topics: the task's own change arrived too.
      expect(named(tab, taskId)).toBeGreaterThan(0);

      // A deciding transaction that rolls back sends nothing; the commit does.
      const raised = inboxSignals(tab);
      await expect(
        pool.withBusiness(s.business, async (tx) => {
          await tx.query(
            `update public.inbox_items set work_state = 'cleared', closed_at = now()
              where business_id = $1 and recipient_person_id = $2 and work_state = 'open'`,
            [s.business, reviewer.personId],
          );
          throw new Error('roll the decision back');
        }),
      ).rejects.toThrow('roll the decision back');
      await settled(tab, taskId);
      expect(inboxSignals(tab)).toBe(raised);

      await approve(s, proposal);
      await within(2_000, () => inboxSignals(tab) > raised, 'the cleared item');

      // The bystander holds no item: their tab heard the task, never an inbox signal.
      await settled(quiet, taskId);
      expect(inboxSignals(quiet)).toBe(0);
    });
  },
);
