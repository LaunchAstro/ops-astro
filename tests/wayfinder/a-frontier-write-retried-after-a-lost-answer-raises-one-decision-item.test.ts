// SPDX-License-Identifier: AGPL-3.0-only
//
// A completion that lands a grilling ticket on its map's frontier, sent again
// after its answer was lost. With the same operation id, sent after the first
// committed or while the first still waits on the map on another connection,
// it replays the first answer and raises nothing more. A client that mints a
// new operation id for its retry is refused on the moved revision, and still
// one item stands.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  chartBlocked,
  decisionsOn,
  holdKey,
  mapRefreshKey,
  settle,
  waitersOf,
  writerOn,
  type Outcome,
  type Writer,
} from './frontier-decision-race.ts';
import { codeOf, wayfinderWorld, type Decider, type WayfinderWorld } from './world.ts';

const serverUrl = databaseUrlFromEnvironment();

const answerOf = (outcome: Outcome): unknown => {
  if ('error' in outcome) throw outcome.error;
  return outcome.answer;
};

// eslint-disable-next-line max-lines-per-function -- one world, the retries that share it
describe.skipIf(serverUrl === undefined)('a frontier write retried after a lost answer', () => {
  let w: WayfinderWorld;
  let owner: Decider;
  let first: Writer;
  let second: Writer;

  beforeAll(async () => {
    w = await wayfinderWorld('frontierretry', 'frontierretry');
    owner = await w.decider('owner');
    first = writerOn(w);
    second = writerOn(w);
  }, 180_000);

  afterAll(async () => {
    await first?.close();
    await second?.close();
    await w?.drop();
  });

  async function blockedTicket() {
    const { map, tickets } = await chartBlocked(w, owner, ['a']);
    const [a, g] = [tickets['a']!, tickets['g']!];
    const revision = await w.revisionOf(a);
    const body = {
      command: 'task.complete',
      operationId: randomUUID(),
      recordId: a,
      expectedRevision: revision,
    };
    return { map, a, g, revision, body };
  }

  const oneOpenItem = async (g: string) =>
    expect(await decisionsOn(w, g)).toStrictEqual([
      { business: w.business, recipient: owner.personId, state: 'open' },
    ]);

  const outcomesOf = async (operationId: string) =>
    (await w.audit())
      .filter((line) => line.operationId === operationId)
      .map((line) => line.outcome)
      .toSorted();

  it('the same operation id sent again after the first committed replays and raises nothing more', async () => {
    const { a, g, revision, body } = await blockedTicket();
    const lost = await first.send(owner, body);
    expect(codeOf(lost)).toBe('applied');
    const again = await second.send(owner, body);
    expect(again).toStrictEqual(lost);
    expect(await w.revisionOf(a)).toBe(revision + 1);
    await oneOpenItem(g);
    expect(await outcomesOf(body.operationId)).toStrictEqual(['applied', 'replayed']);
  });

  it('the same operation id sent while the first still waits on the map raises one item', async () => {
    const { map, a, g, revision, body } = await blockedTicket();
    const held = await holdKey(w, mapRefreshKey(w.business, map));
    let both: Promise<readonly [Outcome, Outcome]> | undefined;
    try {
      const original = settle(first.send(owner, body));
      await waitersOf(w, held.pid, 1);
      // The resend waits on the original's claim of the operation id, or on the map.
      const resend = settle(second.send(owner, body));
      both = Promise.all([original, resend]);
      await waitUntilBlocked(2);
    } finally {
      await held.letGo();
    }
    const [original, resend] = await both;
    expect(codeOf(answerOf(original) as never)).toBe('applied');
    expect(answerOf(resend)).toStrictEqual(answerOf(original));
    expect(await w.revisionOf(a)).toBe(revision + 1);
    await oneOpenItem(g);
    expect(await outcomesOf(body.operationId)).toStrictEqual(['applied', 'replayed']);
  });

  it('a retry under a new operation id is refused on the moved revision and raises nothing more', async () => {
    const { a, g, revision, body } = await blockedTicket();
    expect(codeOf(await first.send(owner, body))).toBe('applied');
    const fresh = await second.send(owner, { ...body, operationId: randomUUID() });
    expect(codeOf(fresh)).not.toBe('applied');
    expect(await w.revisionOf(a)).toBe(revision + 1);
    await oneOpenItem(g);
  });

  /** Waits until `count` backends of this database wait on a lock. */
  async function waitUntilBlocked(count: number): Promise<void> {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      const [row] = await w.db.admin.execute<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'`,
      );
      if (Number(row?.n) >= count) return;
      // oxlint-disable-next-line no-await-in-loop -- polls, one look at a time
      await delay(10);
    }
    throw new Error(`${count} blocked backends never appeared: the schedule was not established`);
  }
});
