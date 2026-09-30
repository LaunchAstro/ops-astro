// SPDX-License-Identifier: AGPL-3.0-only
//
// T3f, the sibling and cap races at the endpoint (T3-N9, B18, B19), through
// the served application's HTTP routes against a real database.
//
// `n` approvals at once, with room for `n - 1` (here n = 4):
//
// - Reservations on one envelope: a task's open envelope has room for three
//   holds, and four lineages on that task are approved at once. Exactly three
//   hold; the fourth is refused `BUDGET_UNAVAILABLE`; the envelope's held
//   total is the three and the cap moves by the three.
// - Envelope opens under one cap: the cap has room for three envelopes, and
//   four first approvals on four tasks arrive at once. Exactly three open;
//   the fourth is refused `BUDGET_EXHAUSTED` and leaves no envelope; the cap's
//   committed total is exact.
//
// W05 (`schedules-w05.test.ts`) holds the two-way case on parked backends;
// these are the n-way cases on the route a client calls.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pathOf } from '../../packages/core-wire/src/surface.ts';
import {
  authorised,
  BUSINESS_KEY,
  createApiFixture,
  post,
  tokenFor,
  type Answer,
  type ApiFixture,
} from './fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('api/t3f-races: DATABASE_URL is unset, so nothing below ran and nothing is proved.');
}

type Name = Parameters<typeof pathOf>[0];

const N = 4;
const EACH = 1_000;

const detail = (answer: Answer): Record<string, unknown> => {
  expect(answer.status, JSON.stringify(answer.body)).toBe(200);
  return answer.body['detail'] as Record<string, unknown>;
};

describe.skipIf(serverUrl === undefined)('T3f n-way races at the endpoint', () => {
  let fixture: ApiFixture;
  let api: Hono;
  let personToken: string;
  let agentToken: string;

  const asPerson = async (name: Name, body: object): Promise<Answer> =>
    await post(api, `/api/b/${BUSINESS_KEY}${pathOf(name)}`, body, authorised(personToken));
  const asAgent = async (name: Name, body: object, delegation?: string): Promise<Answer> =>
    await post(api, `/api/a/b/${BUSINESS_KEY}${pathOf(name)}`, body, {
      ...authorised(agentToken),
      ...(delegation === undefined ? {} : { 'x-agent-delegation': delegation }),
    });

  const task = async (title: string): Promise<string> =>
    String(
      (await asPerson('task.create', { operationId: randomUUID(), fields: { title } })).body[
        'recordId'
      ],
    );

  const revisionOf = async (recordId: string): Promise<number> =>
    Number(
      (
        await fixture.db.admin.execute<{ readonly revision: string }>(
          'select revision::text as revision from public.records where id = $1',
          [recordId],
        )
      )[0]?.revision,
    );

  /** A new lineage on the task, proposed: its gate and version. */
  const proposed = async (recordId: string, maximumMinor: number) =>
    detail(
      await asPerson('task.propose', {
        operationId: randomUUID(),
        recordId,
        expectedRevision: await revisionOf(recordId),
        purpose: 'draft_the_reply',
        maximumMinor,
        currency: 'AUD',
        payload: { instruction: 'draft a reply to the client' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      }),
    );

  const approve = async (gate: Record<string, unknown>): Promise<Answer> =>
    await asPerson('task.decide', {
      operationId: randomUUID(),
      gateId: gate['gateId'],
      versionId: gate['versionId'],
      decision: 'approve',
      note: 'approved in the race',
    });

  const committed = async (): Promise<number> =>
    Number(
      (
        await fixture.db.admin.execute<{ readonly n: string }>(
          `select coalesce(sum(held_minor + actual_minor), 0)::text as n
             from public.task_envelopes where business_id = $1`,
          [fixture.business],
        )
      )[0]?.n,
    );

  /** The route's answers to `n` approvals sent at once, as codes. */
  const race = async (gates: readonly Record<string, unknown>[]): Promise<string[]> =>
    (await Promise.all(gates.map((gate) => approve(gate)))).map((answer) =>
      answer.status === 200 ? 'applied' : String(answer.body['code']),
    );

  beforeAll(async () => {
    fixture = await createApiFixture('t3frace');
    api = fixture.compose();
    personToken = await tokenFor(fixture.member.presented.subject);
    agentToken = await tokenFor(fixture.agent.subject);
  }, 120_000);

  afterAll(async () => {
    await fixture?.drop();
  });

  it(`reservations: ${String(N)} approvals on one envelope with room for ${String(N - 1)}; exactly ${String(N - 1)} hold`, async () => {
    const recordId = await task('one envelope, four lineages');
    // The first approval opens the envelope at three holds' room; its hand-back
    // gives the hold back to the envelope and leaves it open.
    const first = detail(await approve(await proposed(recordId, (N - 1) * EACH)));
    const picked = detail(
      await asAgent('task.pickup', {
        operationId: randomUUID(),
        reservationId: first['reservationId'],
      }),
    );
    detail(
      await asAgent(
        'task.handback',
        {
          operationId: randomUUID(),
          leaseId: picked['leaseId'],
          fence: picked['fence'],
          outcome: 'completed',
          report: { wrote: 'the first draft' },
        },
        String(picked['credential']),
      ),
    );
    const before = await committed();
    const gates = [];
    for (let at = 0; at < N; at += 1) {
      // Sequential: each proposal reads the task's revision the last one moved.
      // eslint-disable-next-line no-await-in-loop
      gates.push(await proposed(recordId, EACH));
    }

    const codes = await race(gates);
    expect(codes.toSorted()).toStrictEqual([
      'BUDGET_UNAVAILABLE',
      ...Array.from({ length: N - 1 }, () => 'applied'),
    ]);
    const envelope = await fixture.db.admin.execute<{ readonly held: string; readonly n: string }>(
      `select env.held_minor::text as held,
              (select count(*) from public.reservations res
                where res.envelope_id = env.id and res.state = 'held')::text as n
         from public.task_envelopes env where env.task_id = $1`,
      [recordId],
    );
    expect(envelope).toEqual([{ held: String((N - 1) * EACH), n: String(N - 1) }]);
    expect(await committed()).toBe(before + (N - 1) * EACH);
  }, 120_000);

  it(`envelope opens: ${String(N)} first approvals under one cap with room for ${String(N - 1)}; exactly ${String(N - 1)} open`, async () => {
    const before = await committed();
    await fixture.db.admin.execute(
      'update public.budget_caps set limit_minor = $2 where business_id = $1',
      [fixture.business, before + (N - 1) * EACH],
    );
    const tasks: string[] = [];
    const gates = [];
    for (let at = 0; at < N; at += 1) {
      // eslint-disable-next-line no-await-in-loop
      const recordId = await task(`competitor ${String(at)}`);
      tasks.push(recordId);
      // eslint-disable-next-line no-await-in-loop
      gates.push(await proposed(recordId, EACH));
    }

    const codes = await race(gates);
    expect(codes.toSorted()).toStrictEqual([
      'BUDGET_EXHAUSTED',
      ...Array.from({ length: N - 1 }, () => 'applied'),
    ]);
    const opened = await fixture.db.admin.execute<{ readonly task_id: string }>(
      'select task_id from public.task_envelopes where task_id = any($1::uuid[])',
      [tasks],
    );
    expect(opened).toHaveLength(N - 1);
    expect(await committed()).toBe(before + (N - 1) * EACH);
  }, 120_000);
});
