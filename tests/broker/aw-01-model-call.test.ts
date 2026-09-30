// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-01's command: `model.call` on the agent prefix, through the real
// boundary, the real envelope, custody's own process and the replay provider
// on loopback. The caller is the lease holder the envelope resolved, never
// the body; the call runs under the delegation the pickup minted; a repeat of
// one operation id never sends twice; and a deployment with no broker answers
// that the part the command rests on has not landed, with nothing written.

import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { createBusinessResolver } from '../../apps/api/server.ts';
import {
  executeAgentCommand,
  executeCommand,
  executeRead,
  modelCallExecutor,
} from '../../packages/core-commands/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import { statusOf } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER } from '../../packages/core-wire/src/index.ts';
import { openCustodyWorld, type CustodyWorld } from '../custody/custody-world.ts';
import {
  liveWork,
  openSchedules,
  type Schedules,
  type Work,
} from '../runtime/schedules-harness.ts';
import { ISSUER, tokenFor } from '../api/fixture.ts';
import { testSignIn } from '../support/sign-in.ts';

const serverUrl = databaseUrlFromEnvironment();

interface Answer {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

// No step: the call bills the step its lease's attempt was reserved for.
const bodyFor = (
  work: Work,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  operationId: randomUUID(),
  leaseId: work.picked['leaseId'],
  fence: work.picked['fence'],
  operation: REPLAY_COMPOSE.key,
  // Bound to the run's own task, which a person entered (S3).
  fields: [{ name: 'tone', from: { recordId: work.taskId, key: 'title' } }],
  ...extra,
});

/** Every case needs the database; without one the file is skipped. */
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

let s: Schedules;
let world: CustodyWorld;
let key: string;
let agentToken: string;
let personToken: string;
let brokered: Hono;
let unconfigured: Hono;

const boundary = (withBroker: boolean): Hono =>
  createApi({
    database: s.db.app,
    verify: createSupabaseVerifier(testSignIn(ISSUER)),
    resolveBusiness: createBusinessResolver(s.db.admin),
    executeRead,
    executeCommand,
    executeAgentCommand,
    ...(withBroker
      ? {
          executeModelCall: modelCallExecutor({
            custody: world.custody,
            operations: catalogue([REPLAY_COMPOSE]),
            providers: new Map([['replay', { build: replayAdapter, price: replayCostMinor }]]),
            routes: [
              {
                key: 'replay',
                reach: 'cloud',
                provider: 'replay',
                credentialRef: 'replay_key',
                credentialKind: 'api_key',
                installation: 'here',
                ceiling: 1_000,
              },
            ],
            installation: 'here',
          }),
        }
      : {}),
  });

const post = async (
  app: Hono,
  prefix: 'a/b' | 'b',
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>>,
): Promise<Answer> => {
  const response = await app.fetch(
    new Request(`http://api.test/api/${prefix}/${key}/model/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, body: (await response.json()) as Answer['body'] };
};

const asAgent = async (
  work: Work,
  body: Readonly<Record<string, unknown>>,
  app: Hono = brokered,
): Promise<Answer> =>
  await post(app, 'a/b', body, {
    authorization: `Bearer ${agentToken}`,
    [DELEGATION_HEADER]: String(work.picked['credential']),
  });

const callsOn = async (work: Work): Promise<readonly Record<string, unknown>[]> =>
  await s.db.admin.execute(
    `select id, state, reserved_minor::text as reserved_minor, actual_minor::text as actual_minor
       from public.model_calls where lease_id = $1 order by accepted_at`,
    [work.picked['leaseId']],
  );

beforeAll(async () => {
  if (serverUrl === undefined) return;
  s = await openSchedules('aw01modelcall', 1_000_000);
  world = await openCustodyWorld();
  const [row] = await s.db.admin.execute<{ key: string }>(
    'select key from public.businesses where id = $1',
    [s.business],
  );
  key = String(row?.key);
  agentToken = await tokenFor(s.agent.subject);
  personToken = await tokenFor(s.decider.presented.subject);
  brokered = boundary(true);
  unconfigured = boundary(false);
}, 180_000);

afterAll(async () => {
  await world?.close();
  await s?.db.drop();
});

it('AW-01 model.call through the agent route', async () => {
  const work = await liveWork(s, 'one priced call', 2_000);
  world.provider.mode('answer');
  const seen = world.provider.seen.length;
  const answer = await asAgent(work, bodyFor(work));
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    command: 'model.call',
    detail: { state: 'settled', text: 'Drafted.', reservedMinor: 500, actualMinor: 100 },
  });
  expect(world.provider.seen.length).toBe(seen + 1);
  const calls = await callsOn(work);
  expect(calls).toMatchObject([{ state: 'settled', reserved_minor: '500', actual_minor: '100' }]);
  // Every audit row of the call is the agent's, and the command's own event names it.
  const events = await s.db.admin.execute<{ actor_id: string; command: string }>(
    `select actor_id, command from public.audit_events
      where business_id = $1 and command like 'model.call%'
        and occurred_at >= (select accepted_at from public.model_calls where id = $2)`,
    [s.business, calls[0]?.['id']],
  );
  expect(events.map((event) => event.command).toSorted()).toEqual([
    'model.call',
    'model.call_dispatched',
  ]);
  expect(new Set(events.map((event) => event.actor_id))).toEqual(new Set([s.agentActorId]));
});

it('AW-01 model.call caller from the envelope', async () => {
  const work = await liveWork(s, 'the body names no caller', 2_000);
  const seen = world.provider.seen.length;
  const claims = [
    [{ actorId: randomUUID() }, 'FIELD_NOT_WRITABLE'],
    [{ attendedByPersonId: randomUUID() }, 'COMMAND_BODY_INVALID'],
    [{ stepId: randomUUID() }, 'COMMAND_BODY_INVALID'],
  ] as const;
  for (const [claimed, code] of claims) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent(work, bodyFor(work, claimed));
    expect(answer.body['code']).toBe(code);
    expect(answer.status).toBe(statusOf(code));
  }
  expect(world.provider.seen.length).toBe(seen);
  expect(await callsOn(work)).toEqual([]);
});

it('AW-01 model.call replay sends once', async () => {
  const work = await liveWork(s, 'one operation, one send', 2_000);
  world.provider.mode('answer');
  const body = bodyFor(work);
  const seen = world.provider.seen.length;
  const first = await asAgent(work, body);
  const again = await asAgent(work, body);
  expect(first.status).toBe(200);
  expect(again.status).toBe(200);
  const callId = (first.body['detail'] as Record<string, unknown>)['callId'];
  expect(again.body['detail']).toMatchObject({ callId, state: 'settled' });
  // The model's words are handed back once and never stored for a replay.
  expect(again.body['detail']).not.toHaveProperty('text');
  expect(world.provider.seen.length).toBe(seen + 1);
  expect(await callsOn(work)).toHaveLength(1);
});

it('AW-01 model.call concurrent repeat sends once', async () => {
  const work = await liveWork(s, 'two at once, one send', 2_000);
  world.provider.mode('answer');
  const body = bodyFor(work);
  const seen = world.provider.seen.length;
  const both = await Promise.all([asAgent(work, body), asAgent(work, body)]);
  for (const answer of both) expect([200, 409]).toContain(answer.status);
  expect(world.provider.seen.length).toBe(seen + 1);
  expect(await callsOn(work)).toHaveLength(1);
});

it('AW-01 model.call refused before a delegation and on the person prefix', async () => {
  const work = await liveWork(s, 'not without the delegation', 2_000);
  const seen = world.provider.seen.length;
  const bare = await post(brokered, 'a/b', bodyFor(work), {
    authorization: `Bearer ${agentToken}`,
  });
  expect(bare.status).toBe(403);
  expect(bare.body['code']).toBe('DELEGATION_EXCLUDES_OPERATION');
  const person = await post(brokered, 'b', bodyFor(work), {
    authorization: `Bearer ${personToken}`,
  });
  expect(person.status).toBe(403);
  expect(person.body['code']).toBe('SCOPE_NOT_GRANTED');
  expect(world.provider.seen.length).toBe(seen);
  expect(await callsOn(work)).toEqual([]);
});

it('AW-01 model.call refused and recorded as a step', async () => {
  // The reservation cannot cover the operation's priced maximum of 500.
  const work = await liveWork(s, 'too small to cover', 300);
  const body = bodyFor(work);
  const seen = world.provider.seen.length;
  const refused = await asAgent(work, body);
  expect(refused.body['code']).toBe('BUDGET_UNAVAILABLE');
  expect(refused.status).toBe(statusOf('BUDGET_UNAVAILABLE'));
  // The broker's step survives the envelope's refusal, and a repeat adds none.
  expect(await callsOn(work)).toMatchObject([{ state: 'refused', reserved_minor: '0' }]);
  const again = await asAgent(work, body);
  expect(again.body['code']).toBe('BUDGET_UNAVAILABLE');
  expect(await callsOn(work)).toHaveLength(1);
  expect(world.provider.seen.length).toBe(seen);
});

it('AW-01 model.call with no broker configured', async () => {
  const work = await liveWork(s, 'no broker here', 2_000);
  const seen = world.provider.seen.length;
  const answer = await asAgent(work, bodyFor(work), unconfigured);
  expect(answer.status).toBe(501);
  expect(answer.body['code']).toBe('DEPENDENCY_NOT_LANDED');
  expect(world.provider.seen.length).toBe(seen);
  expect(await callsOn(work)).toEqual([]);
});

it('AW-01 model.call (S3): a malformed bound field is refused by name, and nothing is written', async () => {
  const work = await liveWork(s, 'a malformed binding', 2_000);
  const seen = world.provider.seen.length;
  const recordId = work.taskId;
  const malformed: readonly unknown[] = [
    { name: 'tone', from: { recordId, key: 'title', path: 'x' } },
    { name: 'tone', from: { recordId: 7, key: 'title' } },
    { name: 'tone', from: { recordId } },
    { name: 'tone', from: { recordId, key: 'title' }, value: 'plain' },
    { name: 'tone', from: { recordId, key: 'title' }, source: 'business_internal' },
    { name: 'tone', from: [recordId, 'title'] },
    { name: 'tone', from: null },
    { from: { recordId, key: 'title' } },
  ];
  for (const field of malformed) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await asAgent(work, bodyFor(work, { fields: [field] }));
    expect(answer.body['code'], JSON.stringify(field)).toBe('FIELD_VALUE_INVALID');
    expect(answer.status).toBe(statusOf('FIELD_VALUE_INVALID'));
  }
  expect(await callsOn(work)).toEqual([]);
  expect(world.provider.seen.length).toBe(seen);
});
