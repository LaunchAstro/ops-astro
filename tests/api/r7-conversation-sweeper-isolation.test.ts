// SPDX-License-Identifier: AGPL-3.0-only
//
// R7 isolation: two businesses in one database, each with a conversation due
// and a body planted in it. Alpha's window cannot be read, so its pass fails;
// Bravo's purges. Alpha's sweep never wraps or purges Bravo's conversation,
// and Alpha's failures never name Bravo, its conversation or either body.
//
// Within one business: two owners, each with a conversation on a different
// client's task and a canary of its own, swept on the schedule's round. Before
// the sweep, after its wrap-up and after its purge, each owner and a reader
// granted on that client's task alone read their own (the transcript, then
// the wrap-up's quotation); the other owner, the other client's reader, both
// clients and the owner's own agent under its delegation reach nothing of
// either, and the round's failures and log lines name neither.
//
// Red before `apps/api/conversation-sweeper.ts`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepRound } from '../../apps/api/conversation-sweeper.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, shareWithClient, type Member } from '../commands/fixture.ts';
import type { Controls } from './controls-fixture.ts';
import type { Answer } from './fixture.ts';
import { checksWorld, pickedUpOn, type PickedUp } from './mp-6-1-checks-fixture.ts';
import {
  CONVERSATION,
  conversationWorld,
  setConversationWindow,
  started,
  type ConversationWorld,
} from './aw-03-fixture.ts';
import {
  consoleLines,
  raisedFailures,
  REVISION,
  sweeperWorld,
  type SweeperWorld,
} from './r7-sweeper-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('R7 conversation sweeper isolation', () => {
  let s: SweeperWorld;

  beforeAll(async () => {
    s = await sweeperWorld('r7_sweeper_isolation');
  }, 120_000);

  afterAll(async () => {
    await s?.w.drop();
  });

  it("R7 isolation: one business's sweep and its failures never touch or name another's conversations", async () => {
    const alphaCanary = `CANARY-ALPHA-${randomUUID()}`;
    const bravoCanary = `CANARY-BRAVO-${randomUUID()}`;
    const alphaDue = await s.dueInAlpha(`${alphaCanary} Alpha's body`);
    const bravoDue = await s.dueInBravo(`${bravoCanary} Bravo's body`);
    await s.window(s.alpha, 3);
    const { failures, raise } = raisedFailures();
    const over = (businesses: readonly string[]): (() => Promise<void>) =>
      sweepRound(s.db, {
        businesses: async () => await Promise.resolve(businesses),
        codeRevision: REVISION,
        raise,
      });

    const alphaOnly = over([s.alpha]);
    await alphaOnly();
    await alphaOnly();
    expect(await s.wrapUps(alphaDue)).toBe(1);
    expect(await s.messages(alphaDue)).toBe(1);
    expect(await s.wrapUps(bravoDue), "Alpha's sweep wrapped Bravo's conversation").toBe(0);
    expect(await s.messages(bravoDue)).toBe(1);

    const both = over([s.alpha, s.bravo.id]);
    await both();
    await both();
    expect(await s.messages(bravoDue)).toBe(0);
    expect(await s.messages(alphaDue)).toBe(1);

    expect(failures).toEqual([
      { businessId: s.alpha, cause: 'window_unreadable', conversationIds: [] },
      { businessId: s.alpha, cause: 'window_unreadable', conversationIds: [] },
    ]);
    const text = JSON.stringify(failures);
    for (const foreign of [s.bravo.id, bravoDue, bravoCanary, alphaCanary]) {
      expect(text).not.toContain(foreign);
    }
  });
});

interface Planted {
  readonly id: string;
  readonly canary: string;
  readonly title: string;
}

/**
 * `by`'s conversation on a task of its own, the task completed and both eight
 * days quiet, so the next round wraps it and the one after purges it.
 */
async function plantedOnASettledTask(
  w: ConversationWorld,
  by: Member,
  client: string,
): Promise<Planted & { readonly taskId: string }> {
  const created = await w.as(w.owner, 'task.create', { fields: { title: `${client} task` } });
  const taskId = (created.body as { recordId: string }).recordId;
  const canary = `CANARY-${client}-${randomUUID()}`;
  const title = `Title-${client}-${randomUUID()}`;
  const scope = { kind: 'task', id: taskId };
  const id = await started(w, by, { scope, title, body: `${canary} ${client}'s quote` });
  const task = await w.as(w.owner, 'task.read', { recordId: taskId });
  const expectedRevision = (task.body['task'] as { revision: number }).revision;
  const done = await w.as(w.owner, 'task.complete', {
    operationId: randomUUID(),
    recordId: taskId,
    expectedRevision,
  });
  expect(done.status).toBe(200);
  await w.fixture.db.admin.execute(
    `update public.records
        set data = jsonb_set(data, '{completed_at}', to_jsonb((now() - interval '8 days')::text))
      where id = $1`,
    [taskId],
  );
  await w.age(id, 8);
  return { id, canary, title, taskId };
}

/** Nothing of `planted` in the answer: not its canary, its title or its id. */
function nothingOf(answer: Answer, planted: Planted, when: string): void {
  const text = JSON.stringify(answer.body);
  for (const value of [planted.canary, planted.title, planted.id]) {
    expect(text, when).not.toContain(value);
  }
}

const onTask = (id: string) => ({ kind: 'record', id }) as const;

// eslint-disable-next-line max-lines-per-function -- one business, every crossing in it
describe.skipIf(serverUrl === undefined)('R7 sweeper isolation in one business', () => {
  let c: Controls;
  let w: ConversationWorld;
  let work: PickedUp;
  let one: Planted;
  let two: Planted;
  const members: Record<string, Member> = {};

  const readAs = async (member: Member, planted: Planted): Promise<Answer> =>
    await w.as(member, 'conversation.read', { conversationId: planted.id });

  /** Each reader reads their own and nothing of the other; every crossing reaches nothing. */
  async function crossingsHold(when: string): Promise<void> {
    const own: readonly (readonly [string, Planted, Planted])[] = [
      ['owner', one, two],
      ['colleague', two, one],
      ['readerOfOne', one, two],
      ['readerOfTwo', two, one],
    ];
    for (const [name, mine, other] of own) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await readAs(members[name] as Member, mine);
      expect(answer.status, `${name} reads their own ${when}`).toBe(200);
      expect(JSON.stringify(answer.body), `${name} ${when}`).toContain(mine.canary);
      nothingOf(answer, other, `${name} ${when}`);
    }
    const crossings: readonly (readonly [string, Planted])[] = [
      ['owner', two],
      ['colleague', one],
      ['readerOfOne', two],
      ['readerOfTwo', one],
      ['clientOne', one],
      ['clientOne', two],
      ['clientTwo', one],
      ['clientTwo', two],
    ];
    for (const [name, foreign] of crossings) {
      // eslint-disable-next-line no-await-in-loop -- one read at a time
      const answer = await readAs(members[name] as Member, foreign);
      expect(answer.status, `${name} ${when}`).toBeGreaterThanOrEqual(400);
      nothingOf(answer, foreign, `${name} ${when}`);
    }
    for (const foreign of [one, two]) {
      // eslint-disable-next-line no-await-in-loop -- one lease, one call at a time
      const agent = await c.asAgent(
        'conversation.read',
        { conversationId: foreign.id },
        work.credential,
      );
      expect(agent.status, `the owner's agent ${when}`).toBe(403);
      nothingOf(agent, foreign, `the owner's agent ${when}`);
    }
  }

  beforeAll(async () => {
    ({ c } = await checksWorld('r7_sweeper_isolation_within'));
    w = await conversationWorld(c);
    work = await pickedUpOn(c, 'r7_sweeper_crossing');
    const { db, business } = w.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await setConversationWindow(tx, 7);
      await grantTo(tx, w.owner, 'share');
    });
    const plantedOne = await plantedOnASettledTask(w, w.owner, 'client-one');
    const plantedTwo = await plantedOnASettledTask(w, w.colleague, 'client-two');
    one = plantedOne;
    two = plantedTwo;
    members['owner'] = w.owner;
    members['colleague'] = w.colleague;
    members['readerOfOne'] = await enrol(db.app, business, 'reader-one');
    members['readerOfTwo'] = await enrol(db.app, business, 'reader-two');
    await db.app.withBusiness(business, async (tx) => {
      const readerOfOne = members['readerOfOne'] as Member;
      const readerOfTwo = members['readerOfTwo'] as Member;
      await grantTo(tx, readerOfOne, 'read', onTask(plantedOne.taskId), false, CONVERSATION);
      await grantTo(tx, readerOfTwo, 'read', onTask(plantedTwo.taskId), false, CONVERSATION);
    });
    members['clientOne'] = await shareWithClient(db.app, business, w.owner, plantedOne.taskId);
    members['clientTwo'] = await shareWithClient(db.app, business, w.owner, plantedTwo.taskId);
  }, 180_000);

  afterAll(async () => await c?.drop());

  it("R7 isolation in one business: the scheduled wrap-up and purge keep each conversation to its owner and its task's reader", async () => {
    const { failures, raise } = raisedFailures();
    const round = sweepRound(w.fixture.db.app, {
      businesses: async () => await Promise.resolve([w.fixture.business]),
      codeRevision: REVISION,
      raise,
    });
    const count = async (table: string): Promise<number[]> =>
      await Promise.all(
        [one, two].map(
          async (planted) =>
            await w.count(`select count(*) as n from public.${table} where conversation_id = $1`, [
              planted.id,
            ]),
        ),
      );
    await crossingsHold('before the sweep');
    const logged = consoleLines();
    try {
      await round();
      expect(await count('conversation_wrap_ups')).toEqual([1, 1]);
      expect(await count('conversation_messages')).toEqual([1, 1]);
      await crossingsHold('after the wrap-up');
      await round();
      expect(await count('conversation_messages')).toEqual([0, 0]);
      await crossingsHold('after the purge');
    } finally {
      logged.restore();
    }
    expect(failures).toEqual([]);
    for (const planted of [one, two]) {
      for (const value of [planted.canary, planted.title, planted.id]) {
        expect(logged.text()).not.toContain(value);
      }
    }
  });
});
