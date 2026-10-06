// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// C41-A's inbox raise (U38, #495; CS-15.4 `inbox item raised (owns_the_move)`):
// a person step or a client-wait step that opens parks the onboarding with an
// inbox item to whoever owns the move, the step task's assignee or else the
// person who started the onboarding, and the item closes when the step does.
// Over HTTP against a real database. The agent step's own park, at its run's
// approval gate, waits on run start and is held in `c41-a-held.test.ts`.
//
// Client B's name carries a planted canary, so the isolation cases can look
// for it where it must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECORD_CANARY = `record-canary-${randomUUID()}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

interface Item {
  readonly recipient: string;
  readonly task: string;
  readonly reason: string;
  readonly state: string;
  readonly closedBy: string | null;
}

const open = (items: readonly Item[]): readonly Item[] =>
  items.filter((one) => one.state === 'open');

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C41-A inbox raise', () => {
  let controls: Controls;
  let admin: Member;
  let assignee: Member;
  let clientAReader: Member;
  let bravoAdmin: Member;
  let clientA: string;
  let clientB: string;
  let stepsA: Map<string, string>;
  let stepsB: Map<string, string>;

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> =>
    await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );

  const newClient = async (name: string): Promise<string> => {
    const answer = await as(admin, 'record.create', { type: 'client', fields: { name } });
    expect(answer.status).toBe(200);
    return String(detail(answer)['recordId']);
  };

  const start = async (clientId: string): Promise<Map<string, string>> => {
    const answer = await as(admin, 'onboarding.start', { clientId, templateKey: 'standard' });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const steps = detail(answer)['steps'] as readonly { key: string; taskId: string }[];
    return new Map(steps.map((one) => [one.key, one.taskId]));
  };

  const done = async (steps: Map<string, string>, key: string): Promise<void> => {
    const answer = await as(admin, 'onboarding.step_result', {
      recordId: steps.get(key),
      outcome: 'done',
      result: `${key} done`,
    });
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  };

  const revisionOf = async (taskId: string): Promise<number> => {
    const [task] = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    return Number(task?.revision);
  };

  // An item about a task raised straight to one person, as a mention is.
  const mention = async (to: Member, taskId: string): Promise<string> =>
    await controls.fixture.db.app.withBusiness(
      controls.fixture.business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: to.personId,
          subjectRecordId: taskId,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );

  // Every item on this onboarding's tasks, read as the database holds it.
  const itemsOn = async (steps: Map<string, string>): Promise<readonly Item[]> => [
    ...(await controls.fixture.db.admin.execute<Item>(
      `select recipient_person_id::text as recipient, subject_record_id::text as task, reason,
              work_state as state, closed_by_person_id::text as "closedBy"
         from public.inbox_items where subject_record_id = any($1::uuid[])
        order by raised_at, subject_record_id`,
      [[...steps.values()]],
    )),
  ];

  beforeAll(async () => {
    controls = await createControls('c41ainbox');
    const { db, business } = controls.fixture;
    admin = controls.manager;
    assignee = await enrol(db.app, business, 'assignee');
    clientAReader = await enrol(db.app, business, 'clientareader');
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'write', whole, false, 'record');
      await grantTo(tx, assignee, 'write', whole, false, 'task');
      await grantTo(tx, assignee, 'assign', whole, false, 'task');
      await grantTo(tx, admin, 'share', whole, false, 'task');
    });
    clientA = await newClient('Made-up Client A');
    clientB = await newClient(`Client B ${RECORD_CANARY}`);
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, clientAReader, 'read', { kind: 'party', id: clientA }, false, 'task');
    });
    stepsA = await start(clientA);
    stepsB = await start(clientB);

    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'manage', whole, false, 'task');
    });
  });

  afterAll(async () => {
    await controls.drop();
  });

  it('CS-15.4 the onboarding skill parks at every person and client-wait step with an inbox item to the person whose move it is', async () => {
    // The first step is the agent's: nothing is anyone's move yet.
    expect(await itemsOn(stepsA)).toStrictEqual([]);

    await done(stepsA, 'welcome-email');
    const kickoff = stepsA.get('kickoff-call');
    expect(open(await itemsOn(stepsA))).toStrictEqual([
      {
        recipient: admin.personId,
        task: kickoff,
        reason: 'assignment',
        state: 'open',
        closedBy: null,
      },
    ]);

    // The call held opens the site line (a person's) and the access grant
    // (the client's); the call's own item closes, naming who closed it.
    await done(stepsA, 'kickoff-call');
    const after = await itemsOn(stepsA);
    expect(after.find((one) => one.task === kickoff)).toMatchObject({
      state: 'cleared',
      closedBy: admin.personId,
    });
    expect(new Set(open(after).map((one) => one.task))).toStrictEqual(
      new Set([stepsA.get('site-setup'), stepsA.get('access-grant')]),
    );
    expect(open(after).every((one) => one.recipient === admin.personId)).toBe(true);

    // The client's grant done opens an agent step: no item for it.
    await done(stepsA, 'access-grant');
    const last = open(await itemsOn(stepsA));
    expect(last.map((one) => one.task)).toStrictEqual([stepsA.get('site-setup')]);

    const inbox = await as(admin, 'inbox.read', {});
    expect(inbox.status).toBe(200);
    expect(JSON.stringify(inbox.body)).toContain(String(stepsA.get('site-setup')));
  });

  it('C41-A inbox raise: an assigned step’s move goes to its assignee, once, and never to the starter', async () => {
    // The assignee takes the step before it opens: nobody is told of their own
    // assignment, so the item they hold once it opens is the step's move.
    const kickoff = String(stepsB.get('kickoff-call'));
    const took = await as(assignee, 'task.assign', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
      fields: { assignee: assignee.personId },
    });
    expect(took.status, JSON.stringify(took.body)).toBe(200);
    expect(open(await itemsOn(stepsB))).toStrictEqual([]);

    await done(stepsB, 'welcome-email');
    const onKickoff = open(await itemsOn(stepsB)).filter((one) => one.task === kickoff);
    expect(onKickoff).toStrictEqual([
      {
        recipient: assignee.personId,
        task: kickoff,
        reason: 'assignment',
        state: 'open',
        closedBy: null,
      },
    ]);
  });

  it('C41-A isolation: a ready step whose task moves to another client is no longer anyone’s move here', async () => {
    const steps = await start(await newClient('Made-up Client Moving'));
    const kickoff = String(steps.get('kickoff-call'));
    await done(steps, 'welcome-email');
    expect(open(await itemsOn(steps)).map((one) => one.recipient)).toStrictEqual([admin.personId]);
    const moved = await as(admin, 'task.set_party', {
      recordId: kickoff,
      expectedRevision: await revisionOf(kickoff),
      fields: { client: await newClient('Made-up Client Elsewhere') },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // step_result answers 404 for it now, so its item could never close: it is withdrawn.
    expect(open(await itemsOn(steps))).toStrictEqual([]);
  });

  it('C41-A isolation: another business is never raised, told or shown an onboarding step’s item', async () => {
    const bravo = await as(bravoAdmin, 'inbox.read', {}, 'bravo');
    expect(bravo.status).toBe(200);
    const said = JSON.stringify(bravo.body);
    for (const id of [...stepsA.values(), ...stepsB.values(), clientA, clientB]) {
      expect(said).not.toContain(id);
    }
    expect(said).not.toContain(RECORD_CANARY);
    const count = await as(bravoAdmin, 'inbox.count', {}, 'bravo');
    expect(count.status).toBe(200);
    expect(JSON.stringify(count.body)).not.toMatch(/"(?:open|owed|count)":[1-9]/u);
    const [item] = await controls.fixture.db.admin.execute<{ readonly id: string }>(
      `select id::text as id from public.inbox_items where subject_record_id = $1`,
      [stepsA.get('site-setup')],
    );
    const seen = await as(bravoAdmin, 'inbox.seen', { itemId: item?.id }, 'bravo');
    expect(seen.status).toBe(404);
    expect(JSON.stringify(seen.body)).not.toContain(String(item?.id));
  });

  it('C41-A isolation: a holder scoped to one client is raised no step’s move, and shown its own client’s step item but never another client’s', async () => {
    // The owner rule raises the holder nothing of either client's steps.
    const raised = await controls.fixture.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.inbox_items where recipient_person_id = $1',
      [clientAReader.personId],
    );
    expect(raised[0]?.n).toBe('0');
    // One item about each client's step, both raised to the holder.
    const ownTask = String(stepsA.get('site-setup'));
    const own = await mention(clientAReader, ownTask);
    const foreign = await mention(clientAReader, String(stepsB.get('site-setup')));

    const read = await as(clientAReader, 'inbox.read', {});
    expect(read.status).toBe(200);
    const listed = read.body['inbox'] as readonly Record<string, unknown>[];
    // The control: client A's item is listed, readable, and counted.
    expect(listed.find((one) => one['id'] === own)).toMatchObject({
      access: 'readable',
      subjectRecordId: ownTask,
    });
    // The crossing: client B's item, its step and its client are never told.
    const said = JSON.stringify(read.body);
    for (const id of [foreign, ...stepsB.values(), clientB, RECORD_CANARY]) {
      expect(said).not.toContain(id);
    }
    const count = await as(clientAReader, 'inbox.count', {});
    expect(count.status).toBe(200);
    expect(Number(count.body['owed'])).toBe(1);

    const opened = await as(clientAReader, 'inbox.seen', { itemId: own });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const crossed = await as(clientAReader, 'inbox.seen', { itemId: foreign });
    expect({ status: crossed.status, code: crossed.body['code'] }).toStrictEqual({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(JSON.stringify(crossed.body)).not.toContain(RECORD_CANARY);
    const stamped = await controls.fixture.db.admin.execute<{ readonly item: string }>(
      'select item_id::text as item from public.inbox_attention where person_id = $1',
      [clientAReader.personId],
    );
    expect(stamped.map((row) => row.item)).toStrictEqual([own]);
  });

  it('C41-A isolation: an agent under a live delegation on one client’s step task reads that task, no inbox, and nothing of another client’s steps', async () => {
    const task = String(stepsA.get('site-setup'));
    const proposal = await controls.propose(task, await revisionOf(task), 'onboarding_step');
    const picked = await controls.pickup(await controls.approve(proposal));
    const credential = String(picked['credential']);
    const unnamed = [...stepsB.values(), clientB, RECORD_CANARY];

    // The control: its own task, client A's step.
    const own = await controls.asAgent('task.read', { recordId: task }, credential);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(JSON.stringify(own.body)).toContain(task);

    // The crossing: client B's step task, really there and out of its purpose.
    const foreign = await controls.asAgent(
      'task.read',
      { recordId: stepsB.get('site-setup') },
      credential,
    );
    expect({ status: foreign.status, code: foreign.body['code'] }).toStrictEqual({
      status: 403,
      code: 'DELEGATION_OUT_OF_PURPOSE',
    });
    expect(JSON.stringify(foreign.body)).not.toContain(clientB);
    expect(JSON.stringify(foreign.body)).not.toContain(RECORD_CANARY);

    // No inbox at all, so neither client's step is named there.
    for (const name of ['inbox.read', 'inbox.count'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one read, then the other
      const answer = await controls.asAgent(name, {}, credential);
      expect(answer.status, name).not.toBe(200);
      const said = JSON.stringify(answer.body);
      expect(said).not.toContain(task);
      for (const id of unnamed) expect(said, name).not.toContain(id);
    }
  });
});
