// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each case reads the audit rows top to bottom */
//
// #2370 (ORCH-2114-AUDIT condition 1): `task.read` answers from one snapshot and writes its
// audit row afterwards, in a transaction of its own, so the row's `occurred_at` is a moment
// after the answer's snapshot. The row also names when that snapshot was taken (`served_at`,
// the snapshot transaction's time), which the hash covers. No other row carries one, a row
// without one hashes exactly as before, a caller cannot set it, and the database refuses one
// later than the row's own time.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAuditChain } from '../../packages/core-commands/src/commands/audit.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from '../wayfinder/world.ts';

const serverUrl = databaseUrlFromEnvironment();
/** How long the test holds a task read between its snapshot and its audit row. */
const PAUSE_MS = 400;

let w: WayfinderWorld;
let owner: Decider;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await wayfinderWorld('a2370served', 'a2370served');
  owner = await w.decider('Served-at owner');
}, 180_000);
afterAll(async () => await w?.drop());

interface Row {
  readonly seq: string;
  readonly command: string;
  readonly served_at: Date | null;
  readonly occurred_at: Date;
}
const rows = async (): Promise<readonly Row[]> =>
  await w.db.admin.execute<Row>(
    `select seq::text as seq, command, served_at, occurred_at from public.audit_events
      where business_id = $1 order by seq`,
    [w.business],
  );
const lastTaskRead = async (): Promise<Row> => {
  const found = (await rows()).findLast((row) => row.command === 'task.read');
  if (found === undefined) throw new Error('no task.read row');
  return found;
};
const clock = async (): Promise<Date> =>
  (await w.db.admin.execute<{ readonly at: Date }>('select clock_timestamp() as at'))[0]!.at;

/** The app database, holding each repeatable read (the snapshot) open a while after it ends. */
const pausing = (): Database => ({
  log: w.db.app.log,
  close: async () => {},
  withBusiness: async (business, run, options) => {
    const answer = await w.db.app.withBusiness(business, run, options);
    if (options?.isolation === 'repeatable read') {
      await new Promise((resolve) => {
        setTimeout(resolve, PAUSE_MS);
      });
    }
    return answer;
  },
});

describe.skipIf(serverUrl === undefined)('a task read names when its snapshot was taken', () => {
  it('records the snapshot time on the task read row, before the row was written', async () => {
    const ticket = await w.create(owner, { title: 'Served-at ticket' });
    const before = await clock();
    const answer = await executeRead(pausing(), w.business, owner.presented, {
      read: 'task.read',
      recordId: ticket.id,
    } as never);
    expect(codeOf(answer)).toBe('applied');
    const row = await lastTaskRead();
    expect(row.served_at).not.toBeNull();
    const served = new Date(row.served_at!).getTime();
    expect(served).toBeGreaterThanOrEqual(before.getTime());
    expect(new Date(row.occurred_at).getTime() - served).toBeGreaterThanOrEqual(PAUSE_MS - 50);
  });

  it('records no snapshot time on any other read or on a command', async () => {
    const ticket = await w.create(owner, { title: 'Served-at neighbour' });
    await w.read(owner, { read: 'tag.list' });
    await w.read(owner, { read: 'task.read', recordId: ticket.id });
    const all = await rows();
    expect(all.some((row) => row.command === 'tag.list')).toBe(true);
    expect(all.some((row) => row.command === 'task.create')).toBe(true);
    expect(all.filter((row) => row.command !== 'task.read' && row.served_at !== null)).toEqual([]);
    expect(all.filter((row) => row.command === 'task.read' && row.served_at === null)).toEqual([]);
  });

  it('keeps the snapshot time out of a caller’s hands', async () => {
    const ticket = await w.create(owner, { title: 'Served-at offered' });
    const before = await clock();
    await w.read(owner, {
      read: 'task.read',
      recordId: ticket.id,
      servedAt: '2001-01-01T00:00:00.000Z',
      served_at: '2001-01-01T00:00:00.000Z',
    });
    const row = await lastTaskRead();
    if (row.served_at !== null) {
      expect(new Date(row.served_at).getTime()).toBeGreaterThanOrEqual(before.getTime());
    }
    const offered = await w.db.admin.execute<{ readonly n: number }>(
      `select count(*)::int as n from public.audit_events
        where business_id = $1 and served_at < '2002-01-01'`,
      [w.business],
    );
    expect(offered[0]?.n).toBe(0);
  });

  it('covers the snapshot time in the hash, and the chain verifies', async () => {
    const ticket = await w.create(owner, { title: 'Served-at chain' });
    await w.read(owner, { read: 'task.read', recordId: ticket.id });
    const report = await w.db.app.withBusiness(w.business, verifyAuditChain);
    expect(report.intact).toBe(true);
    const row = await lastTaskRead();
    const [moved] = await w.db.admin.execute<{ readonly stored: string; readonly moved: string }>(
      `select a.hash as stored,
              public.audit_event_hash(a.prev_hash, a.business_id, a.seq, a.occurred_at, a.actor_id,
                a.command, a.operation_id, a.outcome, a.refusal_code, a.subject_record_id,
                a.payload_digest, a.attempted, a.origin_conversation_id, a.field_changes,
                a.served_at - interval '1 second') as moved
         from public.audit_events a where a.business_id = $1 and a.seq = $2`,
      [w.business, row.seq],
    );
    expect(moved?.moved).not.toBe(moved?.stored);
  });

  it('hashes a row without a snapshot time exactly as before', async () => {
    await w.create(owner, { title: 'Served-at old shape' });
    // The hash every row was written with before `served_at` existed (20261011034325).
    const changed = await w.db.admin.execute<{ readonly seq: string }>(
      `select a.seq::text as seq from public.audit_events a
        where a.business_id = $1 and a.served_at is null
          and a.hash <> encode(sha256(convert_to(
            coalesce(a.prev_hash, '') || '|' || a.business_id::text || '|' || a.seq::text || '|' ||
            to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
            a.actor_id::text || '|' || a.command || '|' || coalesce(a.operation_id, '') || '|' ||
            a.outcome || '|' || coalesce(a.refusal_code, '') || '|' ||
            coalesce(a.subject_record_id::text, '') || '|' || a.payload_digest || '|' ||
            coalesce(a.attempted::text, '') ||
            coalesce('|origin_conversation:' || a.origin_conversation_id::text, '') ||
            coalesce('|field_changes_v1:' || a.field_changes::text, ''), 'utf8')), 'hex')`,
      [w.business],
    );
    const counted = await w.db.admin.execute<{ readonly n: number }>(
      'select count(*)::int as n from public.audit_events where business_id = $1 and served_at is null',
      [w.business],
    );
    expect(counted[0]?.n).toBeGreaterThan(0);
    expect(changed).toEqual([]);
  });

  it('refuses a snapshot time later than the row, or on a row that is no task read', async () => {
    const attempt = async (command: string, servedAt: string) =>
      await w.db.admin
        .execute(
          `insert into public.audit_events
             (business_id, id, actor_id, command, operation_id, outcome, refusal_code,
              subject_record_id, payload_digest, attempted, seq, prev_hash, hash, served_at)
           values ($1, gen_random_uuid(), $2, $3, null, 'applied', null, null, $4, null, 1, null,
                   repeat('0', 64), ${servedAt})`,
          [w.business, owner.actorId, command, 'd'.repeat(64)],
        )
        .then(
          () => 'written',
          (cause: { readonly code?: string }) => cause.code,
        );
    expect(await attempt('task.read', "now() + interval '1 hour'")).toBe('23514');
    expect(await attempt('task.update', 'now()')).toBe('23514');
  });
});
