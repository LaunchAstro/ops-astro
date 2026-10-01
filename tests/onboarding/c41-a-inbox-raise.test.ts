// SPDX-License-Identifier: AGPL-3.0-only
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
    const kickoff = String(stepsB.get('kickoff-call'));
    const [task] = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [kickoff],
    );
    const assigned = await as(admin, 'task.assign', {
      recordId: kickoff,
      expectedRevision: Number(task?.revision),
      fields: { assignee: assignee.personId },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

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

  it('C41-A isolation: a holder scoped to one client is raised nothing and shown nothing of either client’s steps', async () => {
    const reader = await as(clientAReader, 'inbox.read', {});
    expect(reader.status).toBe(200);
    const said = JSON.stringify(reader.body);
    for (const id of [...stepsA.values(), ...stepsB.values()]) expect(said).not.toContain(id);
    expect(said).not.toContain(RECORD_CANARY);
    const raised = await controls.fixture.db.admin.execute<{ readonly n: string }>(
      'select count(*)::text as n from public.inbox_items where recipient_person_id = $1',
      [clientAReader.personId],
    );
    expect(raised[0]?.n).toBe('0');
  });

  it('C41-A isolation: an agent under a live delegation on a step’s task reads no inbox and is told no step', async () => {
    const task = String(stepsA.get('site-setup'));
    const [row] = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [task],
    );
    const proposal = await controls.propose(task, Number(row?.revision), 'onboarding_step');
    const picked = await controls.pickup(await controls.approve(proposal));
    for (const name of ['inbox.read', 'inbox.count'] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one read, then the other
      const answer = await controls.asAgent(name, {}, String(picked['credential']));
      expect(answer.status, name).not.toBe(200);
      const said = JSON.stringify(answer.body);
      expect(said).not.toContain(task);
      expect(said).not.toContain(RECORD_CANARY);
    }
  });
});
