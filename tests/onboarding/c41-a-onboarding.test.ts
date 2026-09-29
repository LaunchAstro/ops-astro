// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one ticket's named cases over one seeded world */
//
// C41-A: new client onboarding, template to tasks, and the step results the
// onboarding skill writes, over HTTP against a real database. Each case is
// named after the acceptance line or supporting checklist line it proves
// (U38, #495). The lines that wait on work not built yet (the run, the inbox
// raise, the email send path, the first-client gate, the kit look) are held,
// named, in `c41-a-held.test.ts`.
//
// Client B's name carries a planted canary and one step result carries a
// planted secret, so the isolation and canary cases can look for them where
// they must not be.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { createControls, type Controls } from '../api/controls-fixture.ts';
import { COMMAND_SURFACE, pathOf } from '../../packages/core-wire/src/surface.ts';
import { ONBOARDING_TEMPLATES } from '../../packages/core-records/src/index.ts';

const serverUrl = databaseUrlFromEnvironment();
const RECORD_CANARY = `record-canary-${randomUUID()}`;
const SECRET_CANARY = `sk_live_${randomUUID().replaceAll('-', '')}`;

const path = (business: string, name: string): string =>
  `/api/b/${business}/${name.replace('.', '/')}`;

const detail = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] ?? {}) as Record<string, unknown>;

// A task read answers `{ task }`, the detail carrying its comments.
const commentBodies = (read: Record<string, unknown>): readonly string[] =>
  (
    ((read['task'] as Record<string, unknown> | undefined)?.['comments'] ?? []) as readonly Record<
      string,
      unknown
    >[]
  ).map((one) => String(one['body']));

interface StepView {
  readonly key: string;
  readonly phase: string;
  readonly kind: 'agent' | 'person' | 'client';
  readonly taskId: string;
  readonly dependsOn: readonly string[];
  readonly state: string;
}

// eslint-disable-next-line max-lines-per-function -- one world, the cases that share it
describe.skipIf(serverUrl === undefined)('C41-A new client onboarding', () => {
  let controls: Controls;
  let admin: Member;
  let recordOnly: Member;
  let taskOnly: Member;
  let clientAWriter: Member;
  let bravoAdmin: Member;
  const answers: Answer[] = [];
  const said: string[] = [];

  const as = async (
    who: Member,
    name: string,
    body: Readonly<Record<string, unknown>>,
    business = 'alpha',
  ): Promise<Answer> => {
    const answer = await post(
      controls.api,
      path(business, name),
      { operationId: randomUUID(), ...body },
      authorised(await tokenFor(who.presented.subject)),
    );
    answers.push(answer);
    return answer;
  };

  const newClient = async (name: string, who = admin): Promise<string> => {
    const answer = await as(who, 'record.create', { type: 'client', fields: { name } });
    expect(answer.status).toBe(200);
    return String(detail(answer)['recordId']);
  };

  const start = async (clientId: string, who = admin): Promise<Answer> =>
    await as(who, 'onboarding.start', { clientId, templateKey: 'standard' });

  const stepsOf = (answer: Answer): readonly StepView[] =>
    detail(answer)['steps'] as readonly StepView[];

  const result = async (
    who: Member,
    taskId: string,
    outcome: 'done' | 'failed',
    text: string,
  ): Promise<Answer> =>
    await as(who, 'onboarding.step_result', { recordId: taskId, outcome, result: text });

  const readTask = async (who: Member, taskId: string): Promise<Record<string, unknown>> => {
    const answer = await as(who, 'task.read', { recordId: taskId });
    expect(answer.status).toBe(200);
    return answer.body;
  };

  // An agent picked up on this task: its delegation's purpose is the task.
  const asDelegatedAgent = async (
    taskId: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<Answer> => {
    const task = await controls.fixture.db.admin.execute<{ readonly revision: string }>(
      'select revision::text as revision from public.records where id = $1',
      [taskId],
    );
    const proposal = await controls.propose(taskId, Number(task[0]?.revision), 'onboarding_step');
    const picked = await controls.pickup(await controls.approve(proposal));
    const answer = await controls.asAgent(
      'onboarding.step_result',
      { operationId: randomUUID(), ...body },
      String(picked['credential']),
    );
    answers.push(answer);
    return answer;
  };

  // A step of this onboarding that takes a result now, read at the time
  // (earlier cases close steps of the shared onboardings).
  const readyStep = async (started: Answer): Promise<string> => {
    const rows = await controls.fixture.db.admin.execute<{ readonly task_id: string }>(
      `select task_id from public.onboarding_steps
        where onboarding_id = $1 and state = 'ready' order by position limit 1`,
      [String(detail(started)['onboardingId'])],
    );
    return String(rows[0]?.task_id);
  };

  const tableRows = async (table: string): Promise<number> =>
    await controls.count(`select count(*) as n from public.${table}`, []);

  let clientA: string;
  let clientB: string;
  let startedA: Answer;
  let startedB: Answer;

  // eslint-disable-next-line max-lines-per-function -- the world, built in one place
  beforeAll(async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      said.push(String(chunk));
      return true;
    });
    afterAll(() => {
      out.mockRestore();
      err.mockRestore();
    });
    controls = await createControls('c41a');
    const { db, business } = controls.fixture;
    admin = controls.manager;
    recordOnly = await enrol(db.app, business, 'recordonly');
    taskOnly = await enrol(db.app, business, 'taskonly');
    clientAWriter = await enrol(db.app, business, 'clientawriter');
    const whole = { kind: 'business', id: null } as const;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, admin, 'write', whole, false, 'record');
      await grantTo(tx, recordOnly, 'write', whole, false, 'record');
      await grantTo(tx, recordOnly, 'read', whole, false, 'task');
      await grantTo(tx, taskOnly, 'write', whole, false, 'task');
    });
    clientA = await newClient('Made-up Client A');
    clientB = await newClient(`Client B ${RECORD_CANARY}`);
    await db.app.withBusiness(business, async (tx) => {
      const partyA = { kind: 'party', id: clientA } as const;
      await grantTo(tx, clientAWriter, 'write', partyA, false, 'task');
    });
    startedA = await start(clientA);
    startedB = await start(clientB);
    (await import('node:fs')).writeFileSync('.local/said.txt', said.join(''));

    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
    bravoAdmin = await enrol(db.app, bravo, 'bravoadmin');
    await db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bravoAdmin, 'write', whole, false, 'record');
      await grantTo(tx, bravoAdmin, 'manage', whole, false, 'task');
    });
  });

  afterAll(async () => {
    await controls.drop();
  });

  it('C41-A owner check: Start onboarding for a made-up client lays its tasks out in phases, first agent step first', () => {
    expect(startedA.status, JSON.stringify(startedA.body)).toBe(200);
    const steps = stepsOf(startedA);
    const template = ONBOARDING_TEMPLATES['standard'];
    expect(template).toBeDefined();
    expect(detail(startedA)['templateVersion']).toBe(template?.version);
    expect(steps.map((one) => one.key)).toStrictEqual(template?.steps.map((one) => one.key));
    // Phases in the template's order, never interleaved.
    const phases = steps.map((one) => one.phase);
    const firstSeen = [...new Set(phases)];
    expect(phases).toStrictEqual(firstSeen.flatMap((p) => phases.filter((one) => one === p)));
    expect(firstSeen.length).toBeGreaterThan(1);
    // The first step that can move is an agent step, ready; everything that
    // depends on an open step waits.
    expect(steps.find((one) => one.state === 'ready')?.kind).toBe('agent');
    for (const one of steps) {
      expect(one.state).toBe(one.dependsOn.length === 0 ? 'ready' : 'blocked');
    }
  });

  it('CS-15.2 start onboarding: the client record, the chosen template, and tasks on that client in phases, each with its kind and dependencies', async () => {
    const rows = await controls.fixture.db.admin.execute<{
      readonly type: string;
      readonly name: string;
    }>(
      `select t.key as type, r.data ->> 'name' as name
         from public.records r join public.record_types t
           on t.business_id = r.business_id and t.id = r.record_type_id
        where r.id = $1`,
      [clientA],
    );
    expect(rows[0]).toStrictEqual({ type: 'client', name: 'Made-up Client A' });
    const steps = stepsOf(startedA);
    const keys = new Set(steps.map((one) => one.key));
    for (const one of steps) {
      expect(['agent', 'person', 'client']).toContain(one.kind);
      for (const needed of one.dependsOn) expect(keys.has(needed)).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- one task read per step
      const task = await readTask(admin, one.taskId);
      expect(String((task['task'] as Record<string, unknown>)['title'])).toContain(one.phase);
      // The party link is not on the task detail; its slot is.
      // eslint-disable-next-line no-await-in-loop -- one task per step
      const link = await controls.fixture.db.admin.execute<{ readonly client: string }>(
        'select uuid_7::text as client from public.records where id = $1',
        [one.taskId],
      );
      expect(link[0]?.client).toBe(clientA);
    }
    expect(new Set(steps.map((one) => one.kind))).toStrictEqual(
      new Set(['agent', 'person', 'client']),
    );
  });

  it('C41-A template site-setup line: sites the agency builds or hosts send frame-ancestors for the product and load the review embed', () => {
    const line = ONBOARDING_TEMPLATES['standard']?.steps.find((one) => one.key === 'site-setup');
    expect(line?.kind).toBe('person');
    expect(line?.title).toMatch(/frame-ancestors/u);
    expect(line?.title).toMatch(/review embed script/u);
    expect(stepsOf(startedA).some((one) => one.key === 'site-setup')).toBe(true);
  });

  it('C41-A every change recorded: the client record, the start, each task and each result read back, audited on the chain', async () => {
    const steps = stepsOf(startedA);
    const onboardingId = String(detail(startedA)['onboardingId']);
    const onboarding = await controls.fixture.db.admin.execute<{
      readonly client_id: string;
      readonly started_by_actor_id: string;
      readonly template_key: string;
      readonly template_version: number;
    }>(
      `select client_id, started_by_actor_id, template_key, template_version
         from public.onboardings where id = $1`,
      [onboardingId],
    );
    expect(onboarding[0]).toStrictEqual({
      client_id: clientA,
      started_by_actor_id: admin.actorId,
      template_key: 'standard',
      template_version: ONBOARDING_TEMPLATES['standard']?.version,
    });
    const stepRows = await controls.count(
      'select count(*) as n from public.onboarding_steps where onboarding_id = $1',
      [onboardingId],
    );
    expect(stepRows).toBe(steps.length);
    const first = steps.find((one) => one.state === 'ready');
    expect((await result(admin, String(first?.taskId), 'done', 'Checked')).status).toBe(200);
    for (const command of ['record.create', 'onboarding.start', 'onboarding.step_result']) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time
      const events = await controls.fixture.db.admin.execute<{ readonly hash: string }>(
        `select hash from public.audit_events
          where actor_id = $1 and command = $2 and outcome = 'applied'`,
        [admin.actorId, command],
      );
      expect(events.length, command).toBeGreaterThan(0);
      for (const event of events) expect(event.hash).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it('C41-A same transaction: a second start for the same client, or an unknown template, writes nothing', async () => {
    const before = [await tableRows('onboardings'), await tableRows('onboarding_steps')];
    const tasksBefore = await tableRows('records');
    const again = await start(clientA);
    expect(again.status).toBe(409);
    expect(again.body['code']).toBe('TRANSITION_NOT_PERMITTED');
    const fresh = await newClient('Made-up Client C');
    const afterClient = await tableRows('records');
    expect(afterClient).toBe(tasksBefore + 1);
    const unknown = await as(admin, 'onboarding.start', {
      clientId: fresh,
      templateKey: 'no-such-template',
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body['code']).toBe('FIELD_VALUE_INVALID');
    expect([await tableRows('onboardings'), await tableRows('onboarding_steps')]).toStrictEqual(
      before,
    );
    expect(await tableRows('records')).toBe(afterClient);
  });

  it('C41-A refusal record:write: without it a client is not created and onboarding does not start', async () => {
    const before = await tableRows('records');
    const create = await as(taskOnly, 'record.create', { type: 'client', fields: { name: 'X' } });
    expect(create.status).toBe(403);
    expect(create.body['code']).toBe('SCOPE_NOT_GRANTED');
    const fresh = await newClient('Made-up Client D');
    const begin = await start(fresh, taskOnly);
    expect(begin.status).toBe(403);
    expect(begin.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await tableRows('records')).toBe(before + 1);
    expect(
      await controls.count('select count(*) as n from public.onboardings where client_id = $1', [
        fresh,
      ]),
    ).toBe(0);
  });

  it('C41-A refusal task:write: without it onboarding lays out no tasks and no step result is written', async () => {
    const fresh = await newClient('Made-up Client E');
    const before = await tableRows('records');
    const begin = await start(fresh, recordOnly);
    expect(begin.status).toBe(403);
    expect(begin.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(await tableRows('records')).toBe(before);
    const step = stepsOf(startedA).find((one) => one.state === 'blocked');
    const written = await result(recordOnly, String(step?.taskId), 'done', 'nope');
    expect(written.status).toBe(403);
    expect(written.body['code']).toBe('SCOPE_NOT_GRANTED');
  });

  it('C41-A step result on its task: an agent step, a person step and a client-wait step each read back from their own task', async () => {
    const fresh = await newClient('Made-up Client F');
    const started = await start(fresh);
    const steps = stepsOf(started);
    const agentStep = steps.find((one) => one.kind === 'agent' && one.dependsOn.length === 0);
    // The agent step, written by an agent under a live delegation on that task.
    const byAgent = await asDelegatedAgent(String(agentStep?.taskId), {
      recordId: agentStep?.taskId,
      outcome: 'done',
      result: 'Welcome email drafted for a person to send',
    });
    expect(byAgent.status, JSON.stringify(byAgent.body)).toBe(200);
    // Walk the rest in dependency order: each person and client step as the
    // steps it depends on close.
    const done = new Set([String(agentStep?.key)]);
    const written: Record<string, string> = {
      [String(agentStep?.taskId)]: 'Welcome email drafted for a person to send',
    };
    for (let pass = 0; pass < steps.length; pass += 1) {
      for (const one of steps) {
        if (done.has(one.key) || !one.dependsOn.every((key) => done.has(key))) continue;
        const text = `${one.kind} step ${one.key} closed`;
        // eslint-disable-next-line no-await-in-loop -- dependency order
        const answer = await result(admin, one.taskId, 'done', text);
        expect(answer.status, one.key).toBe(200);
        done.add(one.key);
        written[one.taskId] = text;
      }
    }
    expect(done.size).toBe(steps.length);
    for (const kind of ['agent', 'person', 'client'] as const) {
      const one = steps.find((step) => step.kind === kind);
      // eslint-disable-next-line no-await-in-loop -- one read per kind
      const read = await readTask(admin, String(one?.taskId));
      expect(commentBodies(read)).toContain(written[String(one?.taskId)]);
    }
    const state = await controls.fixture.db.admin.execute<{ readonly state: string }>(
      'select state from public.onboardings where id = $1',
      [String(detail(started)['onboardingId'])],
    );
    expect(state[0]?.state).toBe('done');
  });

  it('CS-15.4 a step whose dependencies are still open takes no result', async () => {
    const blocked = stepsOf(startedB).find((one) => one.state === 'blocked');
    const answer = await result(admin, String(blocked?.taskId), 'done', 'too early');
    expect(answer.status).toBe(409);
    expect(answer.body['code']).toBe('TRANSITION_NOT_PERMITTED');
  });

  it('CS-15.4 twice failed, it stops and reports on the task, and takes nothing more', async () => {
    const fresh = await newClient('Made-up Client G');
    const started = await start(fresh);
    const first = stepsOf(started).find((one) => one.state === 'ready');
    const taskId = String(first?.taskId);
    expect((await result(admin, taskId, 'failed', 'Provider timed out')).status).toBe(200);
    expect((await result(admin, taskId, 'failed', 'Provider timed out again')).status).toBe(200);
    const onboardingId = String(detail(started)['onboardingId']);
    const state = await controls.fixture.db.admin.execute<{ readonly state: string }>(
      'select state from public.onboardings where id = $1',
      [onboardingId],
    );
    expect(state[0]?.state).toBe('stopped');
    const bodies = commentBodies(await readTask(admin, taskId));
    expect(bodies.some((body) => /stopped after two failed attempts/iu.test(body))).toBe(true);
    const third = await result(admin, taskId, 'done', 'late');
    expect(third.status).toBe(409);
    expect(third.body['code']).toBe('TRANSITION_NOT_PERMITTED');
  });

  it('C41-A isolation: another business cannot start, write or see onboarding for these clients', async () => {
    const before = [await tableRows('onboardings'), await tableRows('onboarding_steps')];
    const foreign = await as(
      bravoAdmin,
      'onboarding.start',
      { clientId: clientA, templateKey: 'standard' },
      'bravo',
    );
    const fabricated = await as(
      bravoAdmin,
      'onboarding.start',
      { clientId: randomUUID(), templateKey: 'standard' },
      'bravo',
    );
    expect(foreign.status).toBe(fabricated.status);
    expect(foreign.body).toStrictEqual(fabricated.body);
    const step = stepsOf(startedA)[0];
    const written = await as(
      bravoAdmin,
      'onboarding.step_result',
      { recordId: step?.taskId, outcome: 'done', result: 'crossing' },
      'bravo',
    );
    expect([403, 404]).toContain(written.status);
    expect([await tableRows('onboardings'), await tableRows('onboarding_steps')]).toStrictEqual(
      before,
    );
    for (const answer of [foreign, fabricated, written]) {
      expect(JSON.stringify(answer.body)).not.toContain(clientA);
      expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
  });

  it('C41-A isolation: a holder scoped to one client writes its steps and never another client’s', async () => {
    const own = await result(clientAWriter, await readyStep(startedA), 'failed', 'Retry later');
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const foreign = await result(clientAWriter, await readyStep(startedB), 'done', 'crossing');
    expect(foreign.status).toBe(403);
    expect(foreign.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(JSON.stringify(foreign.body)).not.toContain(RECORD_CANARY);
    // Nor can it start another client's onboarding: it holds no record:write.
    const begin = await start(clientB, clientAWriter);
    expect(begin.status).toBe(403);
  });

  it('C41-A isolation: an agent under a live delegation for one task writes nothing on another client’s steps', async () => {
    const task = await controls.createTask('agent crossing');
    const proposal = await controls.propose(task.id, task.revision);
    const picked = await controls.pickup(await controls.approve(proposal));
    const credential = String(picked['credential']);
    const before = await tableRows('onboarding_steps');
    const foreignStep = stepsOf(startedB).find((one) => one.state === 'ready');
    for (const [name, body] of [
      ['onboarding.step_result', { recordId: foreignStep?.taskId, outcome: 'done', result: 'x' }],
      ['onboarding.start', { clientId: clientB, templateKey: 'standard' }],
      ['record.create', { type: 'client', fields: { name: 'agent made' } }],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- one crossing at a time
      const answer = await controls.asAgent(
        name,
        { operationId: randomUUID(), ...body },
        credential,
      );
      answers.push(answer);
      expect(answer.status, name).toBe(403);
      expect(JSON.stringify(answer.body)).not.toContain(RECORD_CANARY);
    }
    expect(await tableRows('onboarding_steps')).toBe(before);
  });

  it('C41-A canary: a secret in a step result never reaches the audit payload, logs or another caller', async () => {
    const step = stepsOf(startedB).find((one) => one.state === 'ready');
    const written = await result(admin, String(step?.taskId), 'failed', `key ${SECRET_CANARY}`);
    expect(written.status).toBe(200);
    expect(JSON.stringify(written.body)).not.toContain(SECRET_CANARY);
    const audit = await controls.fixture.db.admin.execute<{ readonly row: string }>(
      `select row_to_json(a)::text as row from public.audit_events a`,
      [],
    );
    for (const one of audit) {
      expect(one.row).not.toContain(SECRET_CANARY);
      expect(one.row).not.toContain(RECORD_CANARY);
    }
    for (const answer of answers.filter((one) => one.status >= 400)) {
      expect(JSON.stringify(answer.body)).not.toContain(SECRET_CANARY);
    }
    expect(said.join('')).not.toContain(SECRET_CANARY);
  });

  it('C41-A nothing leaves before the gate: starting and stepping an onboarding plans no effect and opens no run', async () => {
    const effects = async (): Promise<readonly number[]> => [
      await tableRows('attempts'),
      await tableRows('reservations'),
    ];
    const before = await effects();
    const fresh = await newClient('Made-up Client H');
    const started = await start(fresh);
    const first = stepsOf(started).find((one) => one.state === 'ready');
    await result(admin, String(first?.taskId), 'done', 'Drafted');
    expect(await effects()).toStrictEqual(before);
  });

  it('C41-A parity: each new write is one surface row, reachable by API and command line alike', () => {
    const rows = Object.fromEntries(COMMAND_SURFACE.map((row) => [row.name, row]));
    // A delegation is narrowed to one task (0016), so none reaches a
    // business-wide create yet: both are a person's until the agent's reach
    // widens (flagged against the ticket's table, which allows an agent).
    expect(rows['record.create']).toMatchObject({
      kind: 'write',
      collection: 'record',
      action: 'write',
      agent: 'never',
    });
    expect(rows['onboarding.start']).toMatchObject({
      kind: 'write',
      collection: 'record',
      action: 'write',
      agent: 'never',
    });
    expect(rows['onboarding.step_result']).toMatchObject({
      kind: 'write',
      collection: 'task',
      action: 'write',
      agent: 'delegated',
    });
    expect(pathOf('onboarding.step_result')).toBe('/onboarding/step_result');
  });

  it('C41-A two starts at once for one client: one lays it out, the other is refused, nothing doubles', async () => {
    const fresh = await newClient('Made-up Client K');
    const both = await Promise.all([start(fresh), start(fresh)]);
    expect(both.map((one) => one.status).toSorted()).toStrictEqual([200, 409]);
    expect(
      await controls.count('select count(*) as n from public.onboardings where client_id = $1', [
        fresh,
      ]),
    ).toBe(1);
    expect(
      await controls.count(
        `select count(*) as n from public.records where uuid_7 = $1 and deleted_at is null`,
        [fresh],
      ),
    ).toBe(ONBOARDING_TEMPLATES['standard']?.steps.length);
  });

  it('C41-A isolation: a step whose task moved to another client takes no result from either side', async () => {
    const taskId = await readyStep(startedA);
    await controls.fixture.db.admin.execute(
      `update public.records set data = jsonb_set(data, '{client}', to_jsonb($2::text))
        where id = $1`,
      [taskId, clientB],
    );
    const byA = await result(clientAWriter, taskId, 'done', 'moved away');
    expect(byA.status).toBe(403);
    expect(byA.body['code']).toBe('SCOPE_NOT_GRANTED');
    const byAdmin = await result(admin, taskId, 'done', 'moved away');
    expect(byAdmin.status).toBe(404);
    expect(byAdmin.body['code']).toBe('NOT_FOUND');
    expect(JSON.stringify([byA.body, byAdmin.body])).not.toContain(RECORD_CANARY);
  });
});
