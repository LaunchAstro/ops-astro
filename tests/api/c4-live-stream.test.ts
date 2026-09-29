// SPDX-License-Identifier: AGPL-3.0-only
//
// C4, one event stream per tab, against a real database.
//
// T2f built the live channel for one task per stream; a browser caps a origin
// at about six connections, so a tab opens one stream naming every topic its
// pages follow. Each topic is asked about at join and again before every
// delivery, exactly as T2f asks about its one task; a topic the caller may not
// read is closed alone, and an ended session closes them all.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  connect,
  connectListener,
  revokeGrant,
  type Database,
  type Listener,
} from '../../packages/core-records/src/index.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import { authorised, ISSUER, SECRET, tokenFor } from './fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { createTask, openSchedules, type Schedules } from '../runtime/schedules-harness.ts';
import { cq8World } from '../runtime/cq-8-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/c4-live-stream: DATABASE_URL is unset, so nothing below ran.');
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

interface Joined {
  readonly status: number;
  readonly refusal: Record<string, unknown>;
  readonly heard: Heard[];
  /** Every byte the stream carried, for the proof that it carries nothing else. */
  raw: string;
  ended: boolean;
  stop(): Promise<void>;
}

const topic = (taskId: string): string => `task:${taskId}`;

/** Open one stream naming `topics`, recording each event and its data. */
async function join(api: Hono, key: string, topics: readonly string[], token: string) {
  const query = topics.map((t) => `topic=${encodeURIComponent(t)}`).join('&');
  const response = await api.fetch(
    new Request(`http://api.test${PREFIX.person}${key}/live?${query}`, {
      headers: authorised(token),
    }),
  );
  const heard: Heard[] = [];
  if (response.status !== 200 || response.body === null) {
    const text = await response.text();
    // No route answers in plain text; a refusal is always a JSON object.
    const refusal = text.startsWith('{') ? (JSON.parse(text) as Record<string, unknown>) : {};
    return {
      status: response.status,
      refusal,
      heard,
      raw: text,
      ended: true,
      stop: async () => {},
    };
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const joined: Joined = {
    status: 200,
    refusal: {},
    heard,
    raw: '',
    ended: false,
    stop: async () => await reader.cancel().catch(() => {}),
  };
  void (async () => {
    let buffer = '';
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      joined.raw += value;
      buffer += value;
      for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, at).split('\n');
        const field = (name: string) =>
          lines
            .find((l) => l.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim();
        heard.push({ event: field('event') ?? '', data: field('data') ?? '' });
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

const count = (joined: Joined, event: string, data: string): number =>
  joined.heard.filter((h) => h.event === event && h.data === data).length;

/** The stream carries event names and the caller's own topics, nothing more. */
function carriesOnly(joined: Joined, named: readonly string[]): void {
  for (const line of joined.raw.split('\n')) {
    if (line === '') continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (field === 'event') expect(['resync', 'invalidate', 'closed']).toContain(value);
    else if (field === 'data') expect(named).toContain(value);
    else throw new Error(`the stream carried an unexpected line: ${line}`);
  }
}

describe.skipIf(serverUrl === undefined)(
  'C4 one event stream per tab on a real database',
  { timeout: 30_000 },
  () => {
    let s: Schedules;
    let key: string;
    let pool: Database;
    let listener: Listener;
    let topics: LiveTopics;
    let api: Hono;
    let reads = 0;
    const opened: Joined[] = [];

    const keyOf = async (business: string): Promise<string> => {
      const rows = await s.db.admin.execute<{ key: string }>(
        'select key from public.businesses where id = $1',
        [business],
      );
      return String(rows[0]?.key);
    };

    const open = async (names: readonly string[], who: Member, token?: string, at?: string) => {
      const joined = await join(
        api,
        at ?? key,
        names,
        token ?? (await tokenFor(who.presented.subject)),
      );
      opened.push(joined);
      return joined;
    };

    const touch = async (business: string, recordId: string): Promise<void> => {
      await pool.withBusiness(business, async (tx) => {
        await tx.query('update public.records set data = data where id = $1', [recordId]);
      });
    };

    beforeAll(async () => {
      s = await openSchedules('c4s', 1_000_000);
      key = await keyOf(s.business);
      pool = connect(s.db.appUrl, { max: 4 });
      listener = connectListener(s.db.appUrl);
      topics = await startLiveTopics(listener);
      api = composeApi({
        database: pool,
        admin: s.db.admin,
        secret: SECRET,
        issuer: ISSUER,
        keys: runtimeKeys({ ...process.env }),
        executeRead: async (...args) => {
          reads += 1;
          return await executeRead(...args);
        },
        live: { topics, recheckMs: 200 },
      }).app;
    }, 180_000);

    afterAll(async () => {
      await Promise.allSettled(opened.map(async (joined) => await joined.stop()));
      await topics?.close();
      await pool?.close();
      await s?.db.drop();
    });

    it('C4 one stream per tab: one stream carries every topic it names, each resynced and invalidated on its own', async () => {
      const [one, two] = [await createTask(s, 'c4s-one'), await createTask(s, 'c4s-two')];
      const named = [topic(one), topic(two)];
      const tab = await open(named, s.decider);
      expect(tab.status).toBe(200);
      await within(2_000, () => named.every((t) => count(tab, 'resync', t) === 1), 'resyncs');

      await touch(s.business, one);
      await within(2_000, () => count(tab, 'invalidate', topic(one)) > 0, 'the first topic');
      await sleep(200);
      expect(count(tab, 'invalidate', topic(two))).toBe(0);
      await touch(s.business, two);
      await within(2_000, () => count(tab, 'invalidate', topic(two)) > 0, 'the second topic');
      expect(tab.ended).toBe(false);
      carriesOnly(tab, named);
    });

    it('C4 stream scope: fan-out follows the session’s business, never a topic the caller names, and an ended session closes every topic', async () => {
      const world = cq8World(s);
      const other = await world.party(`c4s-other-${randomUUID().slice(0, 8)}`);
      const theirs = other.tasks[0]?.id ?? '';
      const mine = await createTask(s, `c4s-scope-${randomUUID()}`);
      const named = [topic(mine), topic(theirs)];

      // The other business's member, at their own key, names this business's task too.
      const foreign = await open(named, other.member, undefined, await keyOf(other.id));
      expect(foreign.status).toBe(200);
      await within(2_000, () => count(foreign, 'resync', topic(theirs)) === 1, 'their resync');
      expect(count(foreign, 'closed', topic(mine))).toBe(1);
      expect(count(foreign, 'resync', topic(mine))).toBe(0);
      await Promise.all(Array.from({ length: 10 }, async () => await touch(s.business, mine)));
      await touch(other.id, theirs);
      await within(2_000, () => count(foreign, 'invalidate', topic(theirs)) > 0, 'their write');
      await sleep(200);
      expect(count(foreign, 'invalidate', topic(mine))).toBe(0);
      carriesOnly(foreign, named);

      // Their member at this business's key: refused at the door.
      const crossed = await open([topic(mine)], other.member);
      expect(crossed.status).toBe(403);
      expect(crossed.refusal).toMatchObject({ refused: true, code: 'AUTH_NO_MEMBERSHIP' });

      // A session that expires closes every topic, then the stream.
      const brief = await open(
        [topic(mine), topic(await createTask(s, 'c4s-brief'))],
        s.decider,
        await tokenFor(s.decider.presented.subject, { expiresIn: 1 }),
      );
      expect(brief.status).toBe(200);
      await within(4_000, () => brief.ended, 'the expired session closed');
      expect(brief.heard.filter((h) => h.event === 'closed')).toHaveLength(2);
      expect(brief.heard.at(-1)?.event).toBe('closed');
    });

    it('C4 stream scope, hostile topics: a malformed topic set is refused whole, before any read', async () => {
      const real = topic(await createTask(s, 'c4s-hostile'));
      const id = randomUUID();
      const hostile: readonly (readonly string[])[] = [
        [],
        ['task:'],
        ['task:not-a-uuid'],
        [`Task:${id}`],
        [`record:${id}`],
        [`task:${id.toUpperCase()}`],
        [`task:${id}:extra`],
        [` task:${id}`],
        [`task:${id}\nevent: invalidate`],
        [`task:${id}\u0000`],
        [`task:${id}`, `task:${id}`],
        [real, 'task:not-a-uuid'],
        Array.from({ length: 33 }, () => topic(randomUUID())),
      ];
      const token = await tokenFor(s.decider.presented.subject);
      for (const names of hostile) {
        const before = reads;
        // eslint-disable-next-line no-await-in-loop
        const refused = await open(names, s.decider, token);
        expect([names, refused.status]).toEqual([names, 422]);
        expect(refused.refusal).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['topic'] });
        expect(reads).toBe(before);
      }
    });

    it('C4 revoked: a revoked topic is closed alone, the rest keep delivering, and nothing names more than the caller sent', async () => {
      const [one, two] = [await createTask(s, 'c4s-rev-1'), await createTask(s, 'c4s-rev-2')];
      const narrow = await enrol(s.db.app, s.business, `c4s-narrow-${randomUUID()}`);
      const [grantOne] = await s.db.app.withBusiness(s.business, async (tx) => [
        await grantTo(tx, narrow, 'read', { kind: 'record', id: one }),
        await grantTo(tx, narrow, 'read', { kind: 'record', id: two }),
      ]);
      const named = [topic(one), topic(two)];
      const tab = await open(named, narrow);
      expect(tab.status).toBe(200);
      await within(2_000, () => named.every((t) => count(tab, 'resync', t) === 1), 'resyncs');

      await s.db.admin.execute(
        'update public.grants set revoked_at = now() where business_id = $1 and id = $2',
        [s.business, grantOne],
      );
      await touch(s.business, one);
      await within(2_000, () => count(tab, 'closed', topic(one)) === 1, 'the revoked topic');
      expect(count(tab, 'invalidate', topic(one))).toBe(0);
      await touch(s.business, one);
      await touch(s.business, two);
      await within(2_000, () => count(tab, 'invalidate', topic(two)) > 0, 'the other topic');
      await sleep(200);
      expect(count(tab, 'invalidate', topic(one))).toBe(0);
      expect(count(tab, 'closed', topic(one))).toBe(1);
      expect(tab.ended).toBe(false);
      carriesOnly(tab, named);

      const again = await open([topic(one)], narrow);
      expect(again.status).toBe(403);
      expect(again.refusal).toMatchObject({ refused: true, code: 'SCOPE_NOT_GRANTED' });
      expect(JSON.stringify(again.refusal)).not.toContain(one);
    });

    it('C4 isolation: one stream across another business, another client and a person under a delegation', async () => {
      const world = cq8World(s);
      const other = await world.party(`c4s-iso-${randomUUID().slice(0, 8)}`);
      const mine = await createTask(s, `c4s-iso-${randomUUID()}`);
      const sibling = await createTask(s, `c4s-iso-sibling-${randomUUID()}`);

      // Another business: at its own key it may not follow this task at all.
      const foreign = await open([topic(mine)], other.member, undefined, await keyOf(other.id));
      expect(foreign.status).toBe(404);
      expect(foreign.refusal).toMatchObject({ refused: true, code: 'NOT_FOUND' });

      // Two clients in this business, one shared task each: both stay off the channel.
      await s.db.app.withBusiness(s.business, async (tx) => await grantTo(tx, s.decider, 'share'));
      const first = await world.client(s.business, s.decider, 'c4s-client-1', mine);
      const second = await world.client(s.business, s.decider, 'c4s-client-2', sibling);
      for (const [who, names] of [
        [first, [topic(mine)]],
        [first, [topic(sibling)]],
        [second, [topic(mine), topic(sibling)]],
      ] as const) {
        // eslint-disable-next-line no-await-in-loop
        const refused = await open(names, who);
        expect(refused.status).toBeGreaterThanOrEqual(400);
        expect(refused.refusal).toMatchObject({ refused: true });
      }

      // Another person under a live delegated grant: the one task, while it lives.
      const delegate = await enrol(s.db.app, s.business, `c4s-delegate-${randomUUID()}`);
      const parent = await s.db.app.withBusiness(s.business, async (tx) => {
        const granted = await grantTo(tx, s.decider, 'read', { kind: 'record', id: sibling }, true);
        const issued = await issueGrant(
          tx,
          [
            { kind: 'person', id: s.decider.personId },
            { kind: 'actor', id: s.decider.actorId },
          ],
          {
            subject: { kind: 'person', id: delegate.personId },
            scope: { kind: 'record', id: sibling },
            collection: 'task',
            action: 'read',
            canDelegate: false,
            parentGrantId: granted,
            grantedByActorId: s.decider.actorId,
          },
        );
        if (!issued.ok) throw new Error(`derived grant refused ${issued.refusal.code}`);
        return granted;
      });
      const named = [topic(sibling), topic(mine)];
      const delegated = await open(named, delegate);
      expect(delegated.status).toBe(200);
      await within(2_000, () => count(delegated, 'resync', topic(sibling)) === 1, 'resync');
      expect(count(delegated, 'closed', topic(mine))).toBe(1);
      await s.db.app.withBusiness(s.business, async (tx) => await revokeGrant(tx, parent));
      await touch(s.business, sibling);
      await within(2_000, () => delegated.ended, 'the delegation ended, the stream closed');
      expect(count(delegated, 'closed', topic(sibling))).toBe(1);
      expect(delegated.heard.filter((h) => h.event === 'invalidate')).toEqual([]);
      carriesOnly(delegated, named);
    });
  },
);
