// SPDX-License-Identifier: AGPL-3.0-only
//
// INB-1 raised on transition and INB-1 mention (INB-1b, supporting checklist
// lines C4, C7, C18 and C29). Every case goes through the mounted API, so an
// item is raised by the command that made the transition, inside its
// transaction, and read straight after the answer with no worker running.
//
// The reasons CS-16.8 names, each raised once: a decision for every person who
// holds decide on the task; a finished run (owed nothing) and a failed run
// waiting on its launcher, to the person who authorised the lease; an
// assignment; a mention; and a client-visible comment naming an outside party.
// A superseding proposal withdraws its predecessor's items and raises new ones.
// A refused transition raises none, and a recovery pass raises none.
//
// The separations are named: business to business (another business's decider
// is never a recipient and its reads see no item, and its person cannot be
// mentioned), client to client (a person holding read on one client's tasks is
// refused as a mention on the other client's task, by name) and person to
// person (an item reaches its recipient only, and the actor is never told of
// their own act).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  readInboxItems,
  type InboxItem,
  type InboxReason,
} from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/index.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import { insertActor, insertBusiness, insertPerson } from '../identity/fixture.ts';
import { enrol, grantTo, type Member } from './fixture.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from '../api/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

const ok = (answer: Answer): Answer => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer;
};

const proposal = (task: { id: string; rev: number }, lineageId?: string) => ({
  recordId: task.id,
  expectedRevision: task.rev,
  purpose: 'draft_reply',
  maximumMinor: 1_000,
  currency: 'AUD',
  payload: { instruction: 'draft' },
  step: { kind: 'compose', payload: {} },
  ...(lineageId === undefined ? {} : { lineageId }),
});

describe.skipIf(serverUrl === undefined)('INB-1 raised on transition', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let deciderToken: string;
  let reviewer: Member;
  let writer: Member;
  let writerToken: string;
  let clientStaff: Member;
  let outsider: string;
  let clientA: string;
  let bravo: string;
  let bravoDecider: string;

  const call = async (
    name: Parameters<typeof pathOf>[0],
    body: Readonly<Record<string, unknown>>,
    token: string = deciderToken,
  ): Promise<Answer> =>
    await post(
      api,
      `/api/b/${BUSINESS_KEY}${pathOf(name)}`,
      { operationId: randomUUID(), ...body },
      authorised(token),
    );

  const itemsOf = async (person: string): Promise<readonly InboxItem[]> =>
    await fixture.db.app.withBusiness(
      fixture.business,
      async (tx) => await readInboxItems(tx, person),
    );

  const open = async (person: string, reason: InboxReason): Promise<readonly InboxItem[]> =>
    (await itemsOf(person)).filter((i) => i.reason === reason && i.workState === 'open');

  const allItems = async (): Promise<number> =>
    Number(
      (
        await fixture.db.admin.execute<{ n: string }>(
          'select count(*)::text as n from public.inbox_items',
        )
      )[0]?.n,
    );

  const newTask = async (title: string, client?: string): Promise<{ id: string; rev: number }> => {
    const created = ok(await call('task.create', { fields: { title } })).body;
    const id = String(created['recordId']);
    if (client !== undefined) {
      await fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
        [id, client],
      );
    }
    return { id, rev: Number(created['revision']) };
  };

  beforeAll(async () => {
    fixture = await createApiFixture('inb1b');
    api = fixture.compose();
    deciderToken = await tokenFor(fixture.member.presented.subject);
    reviewer = await enrol(fixture.db.app, fixture.business, 'Rhea Reviewer');
    writer = await enrol(fixture.db.app, fixture.business, 'Wes Writer');
    clientStaff = await enrol(fixture.db.app, fixture.business, 'Cleo Clientside');
    clientA = randomUUID();
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      // Sequential: `issueGrant` reads the granter's own rows.
      for (const action of ['read', 'decide'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, reviewer, action);
      }
      for (const action of ['read', 'write', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, writer, action);
      }
      await grantTo(tx, clientStaff, 'read', { kind: 'party', id: clientA });
      // An outside party: a person with no membership, reading client A's work.
      outsider = await insertPerson(tx, 'Olga Outside');
      await insertActor(tx, outsider);
      await grantTo(tx, { ...clientStaff, personId: outsider }, 'read', {
        kind: 'party',
        id: clientA,
      });
    });
    writerToken = await tokenFor(writer.presented.subject);
    bravo = await insertBusiness(fixture.db.app, 'bravo');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      bravoDecider = await insertPerson(tx, 'Bruno Bravo');
      const actor = await insertActor(tx, bravoDecider);
      await grantTo(
        tx,
        { personId: bravoDecider, actorId: actor, presented: fixture.agent },
        'decide',
      );
    });
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it('raises one decision item per decide holder on a proposal, and none for anyone else', async () => {
    const task = await newTask('decide me');
    const gateId = detailOf(ok(await call('task.propose', proposal(task), writerToken)))['gateId'];
    for (const holder of [fixture.member.personId, reviewer.personId]) {
      // oxlint-disable-next-line no-await-in-loop
      const items = await open(holder, 'decision');
      expect(items.filter((i) => i.subjectRecordId === task.id)).toMatchObject([
        { factKind: 'gate', factId: gateId, owed: true, closedByPersonId: null },
      ]);
    }
    expect(await open(writer.personId, 'decision')).toStrictEqual([]);
    const inBravo = await fixture.db.app.withBusiness(bravo, async (tx) => [
      ...(await tx.query('select id from public.inbox_items')),
      ...(await readInboxItems(tx, bravoDecider)),
    ]);
    expect(inBravo).toStrictEqual([]);
  });

  it('withdraws the superseded version item and raises one on the new gate', async () => {
    const task = await newTask('supersede me');
    const first = detailOf(ok(await call('task.propose', proposal(task))));
    const second = detailOf(
      ok(await call('task.propose', proposal(task, String(first['lineageId'])))),
    );
    const onTask = (await itemsOf(reviewer.personId)).filter((i) => i.subjectRecordId === task.id);
    expect(onTask.map((i) => [i.factId, i.workState, i.closedByPersonId])).toStrictEqual([
      [first['gateId'], 'withdrawn', null],
      [second['gateId'], 'open', null],
    ]);
  });

  it('raises nothing when the transition is refused', async () => {
    const task = await newTask('refuse me');
    const before = await allItems();
    const stale = await call('task.propose', { ...proposal(task), expectedRevision: task.rev + 5 });
    expect(stale.body['code']).toBe('VERSION_STALE');
    expect(await allItems()).toBe(before);
  });

  it('tells the launcher of a finished run (owed nothing) and of a failed one waiting on them', async () => {
    const settle = async (outcome: 'completed' | 'failed', successor?: unknown) => {
      const task = await newTask(`run ${outcome}`);
      const proposed = detailOf(ok(await call('task.propose', proposal(task))));
      const decided = detailOf(
        ok(
          await call('task.decide', {
            gateId: proposed['gateId'],
            versionId: proposed['versionId'],
            decision: 'approve',
            note: 'go',
          }),
        ),
      );
      const picked = detailOf(
        ok(
          await call(
            'task.pickup',
            { reservationId: decided['reservationId'], leaseSeconds: 600 },
            writerToken,
          ),
        ),
      );
      const settled = detailOf(
        ok(
          await call(
            'task.handback',
            { leaseId: picked['leaseId'], fence: picked['fence'], outcome, successor },
            writerToken,
          ),
        ),
      );
      return { task, runId: proposed['runId'], settled };
    };

    const done = await settle('completed', {
      purpose: 'follow_up',
      maximumMinor: 500,
      currency: 'AUD',
      payload: {},
      step: { kind: 'compose', payload: {} },
    });
    expect(
      (await open(fixture.member.personId, 'run_finished')).filter(
        (i) => i.subjectRecordId === done.task.id,
      ),
    ).toMatchObject([{ factKind: 'planned_run', factId: done.runId, owed: false }]);
    expect(await open(writer.personId, 'run_finished')).toStrictEqual([]);
    // The successor the handback wrote is a decision like any other.
    expect((await open(reviewer.personId, 'decision')).map((i) => i.factId)).toContain(
      done.settled['successorGateId'],
    );

    const failed = await settle('failed');
    expect(
      (await open(fixture.member.personId, 'waiting_run')).filter(
        (i) => i.subjectRecordId === failed.task.id,
      ),
    ).toMatchObject([{ factKind: 'planned_run', factId: failed.runId, owed: true }]);
  });

  it('raises an assignment for the assignee, moves it on reassignment, and never for oneself', async () => {
    const task = await newTask('assign me');
    const assign = async (assignee: string, rev: number): Promise<number> =>
      Number(
        ok(
          await call('task.assign', {
            recordId: task.id,
            expectedRevision: rev,
            fields: { assignee },
          }),
        ).body['revision'],
      );
    const rev = await assign(writer.personId, task.rev);
    const forWriter = await open(writer.personId, 'assignment');
    expect(forWriter.filter((i) => i.subjectRecordId === task.id)).toMatchObject([
      { factKind: 'record', factId: task.id },
    ]);
    expect(await open(reviewer.personId, 'assignment')).toStrictEqual([]);
    const rev2 = await assign(reviewer.personId, rev);
    expect(
      (await open(writer.personId, 'assignment')).filter((i) => i.subjectRecordId === task.id),
    ).toStrictEqual([]);
    expect(
      (await open(reviewer.personId, 'assignment')).filter((i) => i.subjectRecordId === task.id),
    ).toHaveLength(1);
    await assign(fixture.member.personId, rev2);
    expect(await open(fixture.member.personId, 'assignment')).toStrictEqual([]);
  });

  it('raises none on a recovery pass', async () => {
    const before = await allItems();
    await fixture.db.app.withBusiness(fixture.business, async (tx) => {
      await replayRecordedTransitions(tx);
    });
    expect(await allItems()).toBe(before);
  });

  describe('INB-1 mention', () => {
    const comment = async (
      task: { id: string; rev: number },
      mentions: readonly string[],
      audience: 'internal' | 'client' = 'internal',
    ): Promise<Answer> =>
      await call('task.comment', {
        recordId: task.id,
        expectedRevision: task.rev,
        body: 'have a look',
        audience,
        mentions,
      });

    const comments = async (task: string): Promise<string> =>
      String(
        (
          await fixture.db.admin.execute<{ n: string }>(
            `select count(*)::text as n from public.records where data ->> 'task' = $1`,
            [task],
          )
        )[0]?.n,
      );

    it('raises a mention for each person named, and none for the author', async () => {
      const task = await newTask('mention me');
      const written = ok(await comment(task, [reviewer.personId, fixture.member.personId]));
      const commentId = detailOf(written)['commentId'];
      expect(
        (await open(reviewer.personId, 'mention')).filter((i) => i.subjectRecordId === task.id),
      ).toMatchObject([{ factKind: 'record', factId: commentId }]);
      expect(await open(fixture.member.personId, 'mention')).toStrictEqual([]);
    });

    it('refuses before save a mention of someone who cannot read the task, naming them', async () => {
      const onA = await newTask('client A', clientA);
      const onB = await newTask('client B', randomUUID());
      ok(await comment(onA, [clientStaff.personId]));
      expect(await open(clientStaff.personId, 'mention')).toHaveLength(1);

      const before = await allItems();
      const refusedB = await comment(onB, [clientStaff.personId]);
      expect(refusedB.status).toBe(422);
      expect(refusedB.body['code']).toBe('MENTION_NOT_READABLE');
      expect(JSON.stringify(refusedB.body['fixes'])).toContain('Cleo Clientside');
      expect(await comments(onB.id)).toBe('0');

      // Another business's person is not a person here, and is not named back.
      const foreign = await comment(onA, [bravoDecider]);
      expect(foreign.body['code']).toBe('MENTION_NOT_READABLE');
      expect(JSON.stringify(foreign.body)).not.toContain('Bruno');

      // An outside party reads client A's task, but not a team-only comment.
      const internal = await comment(onA, [outsider]);
      expect(internal.body['code']).toBe('MENTION_NOT_READABLE');
      expect(JSON.stringify(internal.body['fixes'])).toContain('Olga Outside');
      expect(await allItems()).toBe(before);
    });

    it('raises a client comment for an outside party named in a client-visible comment', async () => {
      const onA = await newTask('client A visible', clientA);
      ok(await comment(onA, [outsider], 'client'));
      expect(await open(outsider, 'client_comment')).toMatchObject([
        { subjectRecordId: onA.id, owed: true, access: 'readable' },
      ]);
      expect(await open(outsider, 'mention')).toStrictEqual([]);
    });

    it('refuses a mentions operand that is not a list of identifiers', async () => {
      const task = await newTask('shape');
      const answer = await call('task.comment', {
        recordId: task.id,
        expectedRevision: task.rev,
        body: 'x',
        audience: 'internal',
        mentions: 'rhea',
      });
      expect(answer.body['code']).toBe('FIELD_VALUE_INVALID');
    });
  });
});
