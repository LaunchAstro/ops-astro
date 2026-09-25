// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1 at 6f13be8, the agent prefix (lane FR1-AGENT).
//
// #6  A task.read over decisions that do not verify answers DECISION_INTEGRITY
//     500 on the agent prefix as on the person prefix (API.md, "A read whose
//     decisions do not verify is a fault"), not SERVICE_UNAVAILABLE's retry.
// #20 The agent's own task named in upper case is its own task: the one-task
//     ceiling compares the id, not its spelling (AUTHORITY.md, "exactly the
//     one task it was minted for").
// #23 A malformed lease id answers as a fabricated one on the agent prefix
//     even when a stray recordId rides along (API.md, id operands).
// #56 An agent OPERATION_ID_REUSED refusal is audited under the identity it
//     collided with, and the register keeps the first request's one row.
// #68 An agent's task.read carries no trace of an internal note: no
//     task.comment entry in its history (API.md, "an internal note is absent
//     from it rather than hidden in it").

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
import { pathOf, type CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';

const serverUrl = databaseUrlFromEnvironment();

const detailOf = (answer: Answer): Record<string, unknown> =>
  (answer.body['detail'] as Record<string, unknown> | undefined) ?? {};

interface Picked {
  readonly taskId: string;
  readonly leaseId: string;
  readonly fence: unknown;
  readonly credential: string;
}

/** A fresh business with a person and an agent, and a way to hand the agent a task. */
async function agentPrefix(part: string) {
  const fixture = await createApiFixture(part);
  const api: Hono = fixture.compose();
  const personToken = await tokenFor(fixture.member.presented.subject);
  const agentToken = await tokenFor(fixture.agent.subject);

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

  const pickUp = async (title: string, purpose: string): Promise<Picked> => {
    const created = await asPerson('task.create', {
      operationId: randomUUID(),
      fields: { title },
    });
    const proposed = await asPerson('task.propose', {
      operationId: randomUUID(),
      recordId: created.body['recordId'],
      expectedRevision: created.body['revision'],
      purpose,
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
      note: 'approved for the final review proof',
    });
    const picked = await asAgent('task.pickup', {
      operationId: randomUUID(),
      reservationId: detailOf(decided)['reservationId'],
    });
    expect(picked.status, JSON.stringify(picked.body)).toBe(200);
    const detail = detailOf(picked);
    return {
      taskId: String(detail['taskId']),
      leaseId: String(detail['leaseId']),
      fence: detail['fence'],
      credential: String(detail['credential']),
    };
  };

  return { fixture, asPerson, asAgent, pickUp };
}

describe.skipIf(serverUrl === undefined)('final review round 1, agent prefix', () => {
  let world: Awaited<ReturnType<typeof agentPrefix>>;
  let fixture: ApiFixture;
  let mine: Picked;
  let sibling: Picked;

  const eventsOf = async (operationId: string) =>
    await fixture.db.admin.execute<Record<string, unknown>>(
      `select command, outcome, refusal_code from public.audit_events
        where business_id = $1 and operation_id = $2 order by seq`,
      [fixture.business, operationId],
    );

  beforeAll(async () => {
    world = await agentPrefix('fr1_agent');
    fixture = world.fixture;
    mine = await world.pickUp('the agent works this one', 'final_r1_mine');
    sibling = await world.pickUp('a sibling task', 'final_r1_sibling');
  }, 120_000);

  afterAll(async () => await fixture?.drop());

  it('#20 serves its own task named in upper case, and still refuses a sibling', async () => {
    const upper = mine.taskId.toUpperCase();
    expect(upper).not.toBe(mine.taskId);

    const read = await world.asAgent(
      'task.read',
      { operationId: randomUUID(), recordId: upper },
      mine.credential,
    );
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body['recordId']).toBe(mine.taskId);

    const comment = await world.asAgent(
      'task.comment',
      { operationId: randomUUID(), recordId: upper, body: 'upper case', audience: 'internal' },
      mine.credential,
    );
    expect(comment.status, JSON.stringify(comment.body)).toBe(200);

    for (const name of ['task.read', 'task.comment'] as const) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time
      const other = await world.asAgent(
        name,
        {
          operationId: randomUUID(),
          recordId: sibling.taskId.toUpperCase(),
          ...(name === 'task.comment' ? { body: 'not mine', audience: 'internal' } : {}),
        },
        mine.credential,
      );
      expect(other.status, `${name} ${JSON.stringify(other.body)}`).toBe(403);
      expect(other.body).toMatchObject({ refused: true, code: 'DELEGATION_OUT_OF_PURPOSE' });
    }
  });

  it('#23 answers a malformed lease id with a stray recordId as a fabricated one', async () => {
    const bodies: Record<'task.heartbeat' | 'task.handback', (leaseId: string) => object> = {
      'task.heartbeat': (leaseId) => ({ leaseId, fence: mine.fence }),
      'task.handback': (leaseId) => ({
        leaseId,
        fence: mine.fence,
        outcome: 'completed',
        report: { wrote: 'nothing' },
      }),
    };
    for (const [name, body] of Object.entries(bodies)) {
      const answers: Answer[] = [];
      for (const leaseId of ['', 'not-a-uuid', randomUUID()]) {
        // eslint-disable-next-line no-await-in-loop -- one call at a time
        const answer = await world.asAgent(
          name as CommandName,
          { ...body(leaseId), operationId: randomUUID(), recordId: sibling.taskId },
          mine.credential,
        );
        answers.push(answer);
      }
      expect(answers[2]?.status, `${name} ${JSON.stringify(answers[2]?.body)}`).toBe(403);
      expect(answers[2]?.body).toMatchObject({ refused: true, code: 'LEASE_NOT_OWNED' });
      for (const answer of answers) expect(answer, name).toStrictEqual(answers[2]);
    }
  });

  it('#56 audits an identity collision under that identity, and registers it once', async () => {
    const operationId = randomUUID();
    const body = { operationId, leaseId: mine.leaseId, fence: mine.fence };
    const first = await world.asAgent('task.heartbeat', body, mine.credential);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const reused = await world.asAgent(
      'task.heartbeat',
      { ...body, leaseSeconds: 120 },
      mine.credential,
    );
    expect(reused.body).toMatchObject({ refused: true, code: 'OPERATION_ID_REUSED' });

    expect(await eventsOf(operationId)).toEqual([
      { command: 'task.heartbeat', outcome: 'applied', refusal_code: null },
      { command: 'task.heartbeat', outcome: 'refused', refusal_code: 'OPERATION_ID_REUSED' },
    ]);
    const registered = await fixture.db.admin.execute<{ readonly outcome: string }>(
      `select outcome from public.operations where business_id = $1 and operation_id = $2`,
      [fixture.business, operationId],
    );
    expect(registered.map((row) => row.outcome)).toEqual(['applied']);
  });

  it('#68 leaves every trace of an internal note out of the agent read', async () => {
    const current = await world.asPerson('task.read', { recordId: mine.taskId });
    const note = await world.asPerson('task.comment', {
      operationId: randomUUID(),
      recordId: mine.taskId,
      expectedRevision: (current.body['task'] as Record<string, unknown>)['revision'],
      body: 'an internal note the agent never sees',
      audience: 'internal',
    });
    expect(note.status, JSON.stringify(note.body)).toBe(200);

    const person = await world.asPerson('task.read', { recordId: mine.taskId });
    const personHistory = (person.body['task'] as Record<string, unknown>)['history'];
    expect(JSON.stringify(personHistory)).toContain('task.comment');

    const agent = await world.asAgent(
      'task.read',
      { operationId: randomUUID(), recordId: mine.taskId },
      mine.credential,
    );
    expect(agent.status, JSON.stringify(agent.body)).toBe(200);
    const whole = JSON.stringify(agent.body);
    expect(whole).not.toContain('an internal note the agent never sees');
    expect(whole).not.toContain('task.comment');
  });
});

describe.skipIf(serverUrl === undefined)('#6 decisions that do not verify, agent prefix', () => {
  let world: Awaited<ReturnType<typeof agentPrefix>>;

  beforeAll(async () => {
    world = await agentPrefix('fr1_agent_integrity');
  }, 120_000);

  afterAll(async () => await world?.fixture.drop());

  it('answers DECISION_INTEGRITY 500 on the agent read, as the person read does', async () => {
    const { fixture } = world;
    const mine = await world.pickUp('the agent reads a tampered chain', 'final_r1_integrity');

    // One signed payload altered as the owner, triggers off for the statement
    // alone (decision-integrity-read.test.ts, "the named fault").
    await fixture.db.admin.execute('alter table public.gate_decisions disable trigger all');
    try {
      await fixture.db.admin.execute(
        `update public.gate_decisions
            set payload = jsonb_set(payload, '{note}', '"approved for something else"')
          where business_id = $1`,
        [fixture.business],
      );
    } finally {
      await fixture.db.admin.execute('alter table public.gate_decisions enable trigger all');
    }
    const before = await fixture.db.admin.execute(
      `select payload from public.gate_decisions where business_id = $1 order by seq`,
      [fixture.business],
    );

    const person = await world.asPerson('task.read', { recordId: mine.taskId });
    expect({ status: person.status, code: person.body['code'] }).toStrictEqual({
      status: 500,
      code: 'DECISION_INTEGRITY',
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop -- the retry is the point
      const agent = await world.asAgent(
        'task.read',
        { operationId: randomUUID(), recordId: mine.taskId },
        mine.credential,
      );
      expect(agent).toStrictEqual(person);
      expect(agent.body['refused']).toBeUndefined();
    }
    const after = await fixture.db.admin.execute(
      `select payload from public.gate_decisions where business_id = $1 order by seq`,
      [fixture.business],
    );
    expect(after).toEqual(before);
  }, 120_000);
});
