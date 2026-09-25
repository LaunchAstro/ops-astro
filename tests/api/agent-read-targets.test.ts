// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's target on the agent prefix, as on the person prefix (Sol 6
// AUTHORITY-3; `boundary-read-targets.test.ts` is the person half).
//
// API.md: a read refuses an identifier it does not take, `COMMAND_BODY_INVALID`
// naming the field. The agent entry answered `task.queue` and
// `session.capabilities` with a stray `recordId` as though it were absent, and
// `task.read` ignored a stray `board`. Each is now refused with one body for
// an own, a foreign and a fabricated id, one refused audit event per call, and
// before the delegation is read. The same reads without the stray field are
// the positive controls.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';
import { enrol, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

type Command = Parameters<typeof executeCommand>[4];

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

describe.skipIf(serverUrl === undefined)('read targets on the agent prefix', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let personToken: string;
  let agentToken: string;
  let ownTask: string;
  let foreignTask: string;
  let pickedTask: string;
  let credential: string;

  const asPerson = async (name: CommandName, body: Record<string, unknown>): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));

  const asAgent = async (
    name: CommandName,
    body: Record<string, unknown>,
    held?: string,
  ): Promise<Answer> =>
    await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`, body, {
      ...authorised(agentToken),
      ...(held === undefined ? {} : { 'x-agent-delegation': held }),
    });

  const eventsOf = async (operationId: string) =>
    await fixture.db.admin.execute<Record<string, unknown>>(
      `select command, outcome, refusal_code, subject_record_id from public.audit_events
        where business_id = $1 and operation_id = $2`,
      [fixture.business, operationId],
    );

  const make = async (business: string, who: Parameters<typeof grantTo>[1], title: string) => {
    const made = await executeCommand(fixture.db.app, business, who.presented, 'api', {
      command: 'task.create',
      operationId: randomUUID(),
      fields: { title },
    } as Command);
    if (isCommandRefusal(made)) throw new Error(`task.create refused ${made.code}`);
    return made.recordId ?? '';
  };

  beforeAll(async () => {
    fixture = await createApiFixture('agent_reads');
    api = fixture.compose();
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
    ownTask = await make(fixture.business, fixture.member, 'an own task');

    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const bea = await enrol(fixture.db.app, bravo, 'bea');
    await fixture.db.app.withBusiness(bravo, async (tx) => {
      await grantTo(tx, bea, 'read');
      await grantTo(tx, bea, 'write');
    });
    foreignTask = await make(bravo, bea, 'a foreign task');

    // A picked-up task, so the agent holds a delegation for the two reads
    // that answer under one.
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title: 'the agent works this one' },
    });
    const proposed = await asPerson('task.propose', {
      operationId: randomUUID(),
      recordId: created.body['recordId'],
      expectedRevision: created.body['revision'],
      purpose: 'read_targets',
      maximumMinor: 2_500,
      currency: 'AUD',
      payload: { instruction: 'draft a reply to the client' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    });
    const decided = await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: detailOf(proposed)['gateId'],
      versionId: detailOf(proposed)['versionId'],
      decision: 'approve',
      note: 'approved for the agent read proof',
    });
    const picked = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: detailOf(decided)['reservationId'],
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    pickedTask = String(detailOf(picked)['taskId']);
    credential = String(detailOf(picked)['credential']);
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  /** Each read, the valid body it takes, the stray field, and whether it runs under the delegation. */
  const CASES = (): readonly (readonly [
    CommandName,
    Record<string, unknown>,
    string,
    boolean,
  ])[] => [
    ['task.queue', {}, 'recordId', false],
    ['session.capabilities', {}, 'recordId', true],
    ['task.read', { recordId: pickedTask }, 'board', true],
  ];

  it('answers each read without the stray field', async () => {
    for (const [name, body, , delegated] of CASES()) {
      const operationId = randomUUID();
      // eslint-disable-next-line no-await-in-loop -- one audit row at a time
      const answer = await asAgent(
        name,
        { ...body, operationId },
        delegated ? credential : undefined,
      );
      expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(200);
      expect(JSON.stringify(answer.body)).not.toContain(foreignTask);
    }
  });

  it('refuses a stray identifier, own, foreign or fabricated, with one body and one event', async () => {
    for (const [name, body, stray, delegated] of CASES()) {
      const answers: Answer[] = [];
      for (const id of [ownTask, foreignTask, randomUUID()]) {
        const operationId = randomUUID();
        // eslint-disable-next-line no-await-in-loop -- one audit row at a time
        const answer = await asAgent(
          name,
          { ...body, operationId, [stray]: id },
          delegated ? credential : undefined,
        );
        expect(answer.status, `${name} ${JSON.stringify(answer.body)}`).toBe(400);
        expect(answer.body).toMatchObject({
          refused: true,
          code: 'COMMAND_BODY_INVALID',
          names: [stray],
        });
        // eslint-disable-next-line no-await-in-loop -- as above
        expect(await eventsOf(operationId)).toEqual([
          {
            command: name,
            outcome: 'refused',
            refusal_code: 'COMMAND_BODY_INVALID',
            subject_record_id: null,
          },
        ]);
        answers.push(answer);
      }
      for (const answer of answers) expect(answer).toStrictEqual(answers[0]);
    }
  });

  it('refuses in the person prefix bytes, before the delegation is read', async () => {
    const person = await asPerson('task.queue', { operationId: randomUUID(), recordId: ownTask });
    const agent = await asAgent('task.queue', { operationId: randomUUID(), recordId: ownTask });
    expect(agent).toStrictEqual(person);
    // No credential at all on a delegated read: the body is refused first.
    const bare = await asAgent('session.capabilities', {
      operationId: randomUUID(),
      recordId: ownTask,
    });
    expect(bare.body).toMatchObject({ code: 'COMMAND_BODY_INVALID', names: ['recordId'] });
  });
});
