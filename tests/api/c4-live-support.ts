// SPDX-License-Identifier: AGPL-3.0-only
//
// The C4 stream suite's harness: open a tab's stream, record what it carries.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { Hono } from 'hono';
import { PREFIX } from '../../packages/core-wire/src/index.ts';
import type { Database, TenantQuery } from '../../packages/core-records/src/index.ts';
import { admitReads, executeRead } from '../../packages/core-commands/src/index.ts';
import { runtimeKeys } from '../../packages/core-runtime/src/index.ts';
import { composeApi } from '../../apps/api/server.ts';
import type { LiveTopics } from '../../apps/api/live.ts';
import type { LivePresence } from '../../apps/api/live-presence.ts';
import type { Schedules } from '../runtime/schedules-harness.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { authorised, ISSUER } from './fixture.ts';
import { testSignIn } from '../support/sign-in.ts';
import { grantTo, type Member } from '../commands/fixture.ts';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function within(ms: number, check: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > ms) throw new Error(`not within ${String(ms)} ms: ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(10);
  }
}

export interface Heard {
  readonly event: string;
  readonly data: string;
}

export interface Joined {
  readonly status: number;
  readonly refusal: Record<string, unknown>;
  readonly heard: Heard[];
  /** Every byte the stream carried, for the proof that it carries nothing else. */
  raw: string;
  ended: boolean;
  stop(): Promise<void>;
}

export const topic = (taskId: string): string => `task:${taskId}`;

/** Read the stream to its end, keeping every byte and each event with its data. */
async function record(reader: ReadableStreamDefaultReader<string>, joined: Joined): Promise<void> {
  let buffer = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      joined.raw += value;
      buffer += value;
      for (let at = buffer.indexOf('\n\n'); at !== -1; at = buffer.indexOf('\n\n')) {
        const lines = buffer.slice(0, at).split('\n');
        const field = (name: string): string =>
          lines
            .find((l) => l.startsWith(`${name}:`))
            ?.slice(name.length + 1)
            .trim() ?? '';
        joined.heard.push({ event: field('event'), data: field('data') });
        buffer = buffer.slice(at + 2);
      }
    }
  } catch {
    // A cancelled read ends the recording like the stream's own end.
  } finally {
    joined.ended = true;
  }
}

/** Open one stream naming `topics`, recording each event and its data. */
export async function join(
  api: Hono,
  key: string,
  topics: readonly string[],
  token: string,
): Promise<Joined> {
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
  void record(reader, joined);
  return joined;
}

export const count = (joined: Joined, event: string, data: string): number =>
  joined.heard.filter((h) => h.event === event && h.data === data).length;

/** The stream carries event names and the caller's own topics, nothing more. */
export function carriesOnly(joined: Joined, named: readonly string[]): void {
  for (const line of joined.raw.split('\n')) {
    if (line === '') continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    if (field === 'event') expect(['resync', 'invalidate', 'closed']).toContain(value);
    else if (field === 'data') expect(named).toContain(value);
    else throw new Error(`the stream carried an unexpected line: ${line}`);
  }
}

/** A grant on one task, delegated from `from` to `to`; the parent grant, to revoke. */
export async function delegatedRead(
  tx: TenantQuery,
  from: Member,
  to: Member,
  recordId: string,
): Promise<string> {
  const granted = await grantTo(tx, from, 'read', { kind: 'record', id: recordId }, true);
  const issued = await issueGrant(
    tx,
    [
      { kind: 'person', id: from.personId },
      { kind: 'actor', id: from.actorId },
    ],
    {
      subject: { kind: 'person', id: to.personId },
      scope: { kind: 'record', id: recordId },
      collection: 'task',
      action: 'read',
      canDelegate: false,
      parentGrantId: granted,
      grantedByActorId: from.actorId,
    },
  );
  if (!issued.ok) throw new Error(`derived grant refused ${issued.refusal.code}`);
  return granted;
}

/** Topic sets the route refuses whole: malformed, repeated, too many, or none. */
export function hostileTopicSets(real: string): readonly (readonly string[])[] {
  const id = randomUUID();
  // Naming no topic at all is the board's stream (INB-1f), not a malformed set.
  return [
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
}

/** The composition root with the live channel mounted, counting every read and every channel check. */
export function liveApi(
  s: Schedules,
  pool: Database,
  topics: LiveTopics,
  onRead: () => void,
  presence?: LivePresence,
): Hono {
  return composeApi({
    database: pool,
    admin: s.db.admin,
    signIn: testSignIn(ISSUER),
    keys: runtimeKeys({ ...process.env }),
    executeRead: async (...args) => {
      onRead();
      return await executeRead(...args);
    },
    live: {
      topics,
      recheckMs: 200,
      ...(presence === undefined ? {} : { presence }),
      admit: async (...args) => {
        onRead();
        return await admitReads(...args);
      },
    },
  }).app;
}

/** The row count of every table in the database, by name: any row written anywhere shows. */
export async function rowCounts(s: Schedules): Promise<Record<string, number>> {
  const tables = await s.db.admin.execute<{ name: string }>(
    `select format('%I.%I', table_schema, table_name) as name from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')
      order by 1`,
  );
  const counted: Record<string, number> = {};
  for (const { name } of tables) {
    // eslint-disable-next-line no-await-in-loop -- one admin connection, table by table.
    const [row] = await s.db.admin.execute<{ n: string }>(`select count(*) as n from ${name}`);
    counted[name] = Number(row?.n);
  }
  return counted;
}
