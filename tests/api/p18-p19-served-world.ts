// SPDX-License-Identifier: AGPL-3.0-only
// Shared fixture only: the existing acceptance world and production API process.
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { expect } from 'vitest';
import { pathOf, type CommandName } from '../../packages/core-wire/src/surface.ts';
import type { TaskExecution } from '../../packages/core-commands/src/reads/execution.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { enrolCaller } from '../acceptance/cast.ts';
import {
  agentPath,
  bearer,
  createWorld,
  personPath,
  type Answer,
  type Caller,
  type World,
} from '../acceptance/world.ts';
import { serveApi, type ServedApi } from '../cli/cli-process-harness.ts';

type Body = Readonly<Record<string, unknown>>;

export interface CreatedTask {
  readonly id: string;
  readonly revision: number;
}

export interface ServedWork {
  readonly taskId: string;
  readonly proposed: Record<string, unknown>;
  readonly picked: Record<string, unknown>;
}

export function witness(event: Body): void {
  const file = process.env['P18P19_FIXTURE_FILE'];
  if (file !== undefined && file !== '') appendFileSync(file, `${JSON.stringify(event)}\n`);
}

export interface ServedWorld {
  readonly world: World;
  readonly api: ServedApi;
  person(who: Caller, name: CommandName, body: Body): Promise<Answer>;
  agent(name: CommandName, body: Body, credential?: string): Promise<Answer>;
  close(): Promise<void>;
}

async function post(
  api: ServedApi,
  path: string,
  body: Body,
  headers: Record<string, string>,
): Promise<Answer> {
  const response = await fetch(`${api.origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ operationId: randomUUID(), ...body }),
  });
  const text = await response.text();
  const parsed = objectOf(JSON.parse(text));
  return {
    status: response.status,
    body: parsed,
    code: parsed['refused'] === true ? String(parsed['code']) : 'ok',
    text,
  };
}

export async function openServedWorld(part: string): Promise<ServedWorld> {
  const world = await createWorld(part);
  let api: ServedApi;
  try {
    api = await serveApi(world);
  } catch (error) {
    await world.close();
    throw error;
  }
  witness({
    kind: 'world',
    part,
    database: world.db.name,
    alpha: world.alpha,
    bravo: world.bravo,
    origin: api.origin,
    pid: api.pid,
  });
  return {
    world,
    api,
    person: async (who, name, body) =>
      await post(api, personPath(who.businessKey, pathOf(name)), body, bearer(who.token)),
    agent: async (name, body, credential) =>
      await post(api, agentPath('alpha', pathOf(name)), body, {
        ...bearer(world.agent.token),
        ...(credential === undefined ? {} : { 'x-agent-delegation': credential }),
      }),
    close: async () => {
      try {
        await api.stop();
      } finally {
        await world.close();
      }
    },
  };
}

export function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected response object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

export function applied(answer: Answer): Record<string, unknown> {
  expect(answer.code, answer.text).toBe('ok');
  expect(answer.status, answer.text).toBe(200);
  return answer.body;
}

export const detailOf = (answer: Answer): Record<string, unknown> =>
  objectOf(applied(answer)['detail']);

export function executionOf(answer: Answer): TaskExecution {
  const execution = objectOf(applied(answer)['execution']);
  expect(Array.isArray(execution['events'])).toBe(true);
  expect(Array.isArray(execution['runs'])).toBe(true);
  return execution as unknown as TaskExecution;
}

export function memberOf(who: Caller): Member {
  if (who.personId === null || who.actorId === null) throw new Error('fixture needs a person');
  return { personId: who.personId, actorId: who.actorId, presented: who.presented };
}

export async function reader(s: ServedWorld, name: string): Promise<Caller> {
  const who = await enrolCaller(s.world.db, s.world.alpha, 'alpha', name, {
    membership: true,
    actions: [],
    collections: [],
  });
  witness({
    kind: 'reader',
    name,
    personId: who.personId,
    actorId: who.actorId,
    business: s.world.alpha,
  });
  return who;
}

export async function task(
  s: ServedWorld,
  title: string,
  who: Caller = s.world.ada,
): Promise<CreatedTask> {
  const body = applied(await s.person(who, 'task.create', { fields: { title } }));
  expect(body['recordId']).toBeTypeOf('string');
  witness({
    kind: 'task',
    title,
    taskId: body['recordId'],
    revision: body['revision'],
    personId: who.personId,
    businessKey: who.businessKey,
  });
  return { id: String(body['recordId']), revision: Number(body['revision']) };
}

export async function client(s: ServedWorld, name: string): Promise<string> {
  const detail = detailOf(await s.person(s.world.ada, 'client.create', { name }));
  expect(detail['clientId']).toBeTypeOf('string');
  witness({ kind: 'client', name, clientId: detail['clientId'] });
  return String(detail['clientId']);
}

export async function linkedTask(s: ServedWorld, title: string, clientId: string): Promise<string> {
  const made = await task(s, title);
  applied(
    await s.person(s.world.ada, 'task.set_party', {
      recordId: made.id,
      expectedRevision: made.revision,
      fields: { client: clientId },
    }),
  );
  return made.id;
}

export async function reach(
  s: ServedWorld,
  who: Caller,
  kind: 'record' | 'party',
  id: string,
): Promise<string> {
  const grant = await s.world.db.app.withBusiness(
    s.world.alpha,
    async (tx) => await grantTo(tx, memberOf(who), 'read', { kind, id }),
  );
  witness({ kind: 'grant', grantId: grant, personId: who.personId, scope: { kind, id } });
  return grant;
}

export async function proposal(
  s: ServedWorld,
  made: { readonly id: string; readonly revision: number },
): Promise<Record<string, unknown>> {
  return detailOf(
    await s.person(s.world.ada, 'task.propose', {
      recordId: made.id,
      expectedRevision: made.revision,
      purpose: `p18p19_${randomUUID().replaceAll('-', '_')}`,
      maximumMinor: 2_000,
      currency: 'AUD',
      payload: { instruction: 'draft a synthetic reply' },
      step: { kind: 'compose', payload: { tone: 'plain' } },
    }),
  );
}

export async function pickup(s: ServedWorld, proposed: Body): Promise<Record<string, unknown>> {
  const decided = detailOf(
    await s.person(s.world.ada, 'task.decide', {
      gateId: proposed['gateId'],
      versionId: proposed['versionId'],
      decision: 'approve',
      note: 'synthetic served-service proof',
    }),
  );
  return detailOf(
    await s.agent('task.pickup', {
      reservationId: decided['reservationId'],
      leaseSeconds: 600,
    }),
  );
}

export async function work(s: ServedWorld, title: string, clientId?: string): Promise<ServedWork> {
  const made = await task(s, title);
  const linked =
    clientId === undefined
      ? undefined
      : applied(
          await s.person(s.world.ada, 'task.set_party', {
            recordId: made.id,
            expectedRevision: made.revision,
            fields: { client: clientId },
          }),
        );
  const proposed = await proposal(s, {
    id: made.id,
    revision: linked === undefined ? made.revision : Number(linked['revision']),
  });
  const picked = await pickup(s, proposed);
  witness({ kind: 'work', taskId: made.id, runId: picked['runId'], leaseId: picked['leaseId'] });
  return { taskId: made.id, proposed, picked };
}

export async function records(
  s: ServedWorld,
  taskId: string,
): Promise<readonly { readonly record: unknown }[]> {
  return await s.world.db.admin.execute<{ readonly record: unknown }>(
    'select to_jsonb(r) as record from public.records r where business_id = $1 and id = $2',
    [s.world.alpha, taskId],
  );
}

export async function auditCount(
  s: ServedWorld,
  command: string,
  outcome: string,
): Promise<number> {
  const [row] = await s.world.db.admin.execute<{ readonly n: string }>(
    `select count(*)::text as n from public.audit_events
      where business_id = $1 and command = $2 and outcome = $3`,
    [s.world.alpha, command, outcome],
  );
  return Number(row?.n);
}

export async function seed201(s: ServedWorld, taskId: string, canary: string): Promise<void> {
  await s.world.db.admin.execute(
    `insert into public.run_events
      (business_id, id, run_id, task_id, position, kind, lease_id, attempt_id, actor_id, detail)
     select ev.business_id, gen_random_uuid(), ev.run_id, ev.task_id,
       ev.position + g, ev.kind, ev.lease_id, ev.attempt_id, ev.actor_id,
       jsonb_build_object('proof', $3::text)
     from public.run_events ev, generate_series(1, 200) g
     where ev.business_id = $1 and ev.task_id = $2 and ev.position = 1`,
    [s.world.alpha, taskId, canary],
  );
  const [row] = await s.world.db.admin.execute<{ readonly n: string }>(
    'select count(*)::text as n from public.run_events where business_id = $1 and task_id = $2',
    [s.world.alpha, taskId],
  );
  expect(Number(row?.n)).toBe(201);
  witness({ kind: 'event-count', taskId, persistedEvents: Number(row?.n), canary });
}
