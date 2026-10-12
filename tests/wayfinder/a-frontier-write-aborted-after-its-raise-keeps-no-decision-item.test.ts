// SPDX-License-Identifier: AGPL-3.0-only
//
// A write that lands a grilling ticket on its map's frontier, aborted at each
// step of the raise: after the raise has read that no item exists and while
// its insert waits on a twin's (between the read and the write), after the
// item is inserted while the write waits at its last sign-in check (between
// the write and the commit), and at commit itself, after the take-back has
// run. Each abort leaves no item and the task as it was, and the same command
// sent again, with the same operation id, raises exactly one. A twin raise
// that commits or rolls back while the write waits on it leaves one item.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  cancel,
  chartBlocked,
  decisionsOn,
  holdKey,
  holdTwinItem,
  letTwinGo,
  onFrontier,
  settle,
  uncommittedItemHeld,
  waitersOf,
  writerOn,
  type Outcome,
  type Writer,
} from './frontier-decision-race.ts';
import { codeOf, wayfinderWorld, type Decider, type Member, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

const appliedOrNot = (outcome: Outcome): string =>
  'error' in outcome ? 'threw' : codeOf(outcome.answer);

/** A deferred trigger that fails the commit of a transaction leaving a marked ticket on the frontier. */
const FAIL_AT_COMMIT = [
  'create table public.frontier_commit_fails_for (ticket_id uuid primary key)',
  `create function public.frontier_commit_fails() returns trigger language plpgsql
     security definer set search_path = pg_catalog, public as $$
   begin
     if exists (select 1 from public.frontier_commit_fails_for where ticket_id = new.ticket_id) then
       raise exception 'the commit fails after the take-back ran';
     end if;
     return null;
   end $$`,
  // Named to fire after map_frontier_takes_back_passing: deferred triggers on one row run by name.
  `create constraint trigger map_frontier_zz_commit_fails after insert on public.map_frontier
     deferrable initially deferred for each row execute function public.frontier_commit_fails()`,
];

// eslint-disable-next-line max-lines-per-function -- one world, the aborts that share it
describe.skipIf(serverUrl === undefined)('a frontier write aborted after its raise', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let writer: Writer;

  beforeAll(async () => {
    w = await wayfinderWorld('frontiercrash', 'frontiercrash');
    owner = await w.decider('owner');
    writer = writerOn(w);
    for (const statement of FAIL_AT_COMMIT) {
      // oxlint-disable-next-line no-await-in-loop -- one statement after another
      await w.db.admin.execute(statement);
    }
  }, 180_000);

  afterAll(async () => {
    await writer?.close();
    await w?.drop();
  });

  const complete = async (id: string) => ({
    command: 'task.complete',
    operationId: randomUUID(),
    recordId: id,
    expectedRevision: await w.revisionOf(id),
  });

  /** Nothing of the aborted write: the blocker unmoved, the ticket off the frontier, no item. */
  async function nothingKept(blocker: string, revision: number, ticket: string): Promise<void> {
    expect(await w.revisionOf(blocker)).toBe(revision);
    expect(await onFrontier(w, ticket)).toBe(false);
    expect(await decisionsOn(w, ticket)).toStrictEqual([]);
  }

  /** The same command again, as a client resends it: one item, open, the owner's. */
  async function retryRaisesOne(body: Record<string, unknown>, ticket: string, by: Member) {
    expect(codeOf(await writer.send(by, body))).toBe('applied');
    expect(await onFrontier(w, ticket)).toBe(true);
    expect(await decisionsOn(w, ticket)).toStrictEqual([
      { business: w.business, recipient: owner.personId, state: 'open' },
    ]);
  }

  it('aborted between its read and its insert, the write keeps nothing and its retry raises one', async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    const body = await complete(a);
    const twin = await holdTwinItem(w, g, owner.personId, 'roll back');
    let outcome: Outcome | undefined;
    try {
      const writing = settle(writer.send(owner, body));
      // The raise read no item, since the twin's is uncommitted, and its insert waits on it.
      const [waiter] = await waitersOf(w, twin.pid, 1);
      await cancel(w, waiter!);
      outcome = await writing;
    } finally {
      await letTwinGo(twin);
    }
    expect(appliedOrNot(outcome!)).not.toBe('applied');
    await nothingKept(a, body.expectedRevision, g);
    await retryRaisesOne(body, g, owner);
  });

  it('aborted between its insert and its commit, the write keeps nothing and its retry raises one', async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    const body = await complete(a);
    // The audit append takes the business's chain key after the handler's frontier write.
    const held = await holdKey(w, w.business);
    let outcome: Outcome | undefined;
    try {
      const writing = settle(writer.send(owner, body));
      const [waiter] = await waitersOf(w, held.pid, 1);
      // The item is already inserted, uncommitted, in the waiting write.
      expect(await uncommittedItemHeld(w, g, owner.personId)).toBe(true);
      await cancel(w, waiter!);
      // The failed attempt's audit event needs the chain key too.
      await held.letGo();
      outcome = await writing;
    } finally {
      await held.letGo();
    }
    expect(appliedOrNot(outcome!)).not.toBe('applied');
    await nothingKept(a, body.expectedRevision, g);
    await retryRaisesOne(body, g, owner);
  });

  it('aborted at its commit after the take-back ran, the write keeps nothing and its retry raises one', async () => {
    const { tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    const body = await complete(a);
    await w.db.admin.execute('insert into public.frontier_commit_fails_for values ($1)', [g]);
    const outcome = await settle(writer.send(owner, body));
    await w.db.admin.execute('delete from public.frontier_commit_fails_for');
    expect(appliedOrNot(outcome!)).not.toBe('applied');
    await nothingKept(a, body.expectedRevision, g);
    await retryRaisesOne(body, g, owner);
  });

  it.each(['commit', 'roll back'] as const)(
    'a twin raise that ends with %s while the write waits on it leaves one item',
    async (end) => {
      const { tickets } = await chartBlocked(w, owner, ['a']);
      const [a, g] = [tickets['a']!, tickets['g']!];
      const twin = await holdTwinItem(w, g, owner.personId, end);
      let outcome: Outcome | undefined;
      try {
        const writing = settle(writer.send(owner, await complete(a)));
        await waitersOf(w, twin.pid, 1);
        await letTwinGo(twin);
        outcome = await writing;
      } finally {
        await letTwinGo(twin);
      }
      expect(appliedOrNot(outcome!)).toBe('applied');
      expect(await onFrontier(w, g)).toBe(true);
      expect(await decisionsOn(w, g)).toStrictEqual([
        { business: w.business, recipient: owner.personId, state: 'open' },
      ]);
    },
  );
});
