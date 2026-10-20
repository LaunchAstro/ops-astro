// SPDX-License-Identifier: AGPL-3.0-only
//
// The client crossing's `task.create` sent through the app's client, the CLI
// and the API: each surface's send is its own attempt under its own operation
// id, so each answer is that surface's own grant check and never a replay of
// the one before it; a refusal writes no task; and a send whose answer is lost,
// sent again under its operation id on any surface, files its task once. Task
// rows are counted on a connection of their own before and after.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectAsAdmin } from '../../packages/core-records/src/tenancy/database.ts';
import { createCli } from '../../apps/cli/client.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { asBrowser } from '../support/sign-in.ts';
import { authorised, post, tokenFor } from './fixture.ts';
import {
  api,
  clientOne,
  fixture,
  rows,
  task,
  through,
  useIsolationWorld,
} from './api-1-isolation-world.ts';
import { threeWays } from './api-1-isolation-surfaces.ts';

const server = databaseUrlFromEnvironment();

/** Alpha's records, counted on a connection opened for this count alone. */
async function recordsNow(): Promise<number> {
  if (server === undefined) throw new Error('no database server is configured');
  const url = new URL(server);
  url.pathname = `/${fixture.db.name}`;
  const own = connectAsAdmin(url.toString());
  try {
    const [row] = await own.execute<{ readonly n: number }>(
      'select count(*)::int as n from public.records where business_id = $1',
      [fixture.business],
    );
    return Number(row?.n);
  } finally {
    await own.close();
  }
}

/** Each `task.create` attempt an actor made, in the order the chain holds them. */
const attemptsBy = async (actorId: string) =>
  await fixture.db.admin.execute<{
    readonly outcome: string;
    readonly code: string | null;
    readonly operation: string | null;
  }>(
    `select outcome, refusal_code as code, operation_id as operation from public.audit_events
      where actor_id = $1 and command = 'task.create' order by seq`,
    [actorId],
  );

const taskUnder = (parentId: string) => ({
  fields: { title: `made-up retried task ${randomUUID()}` },
  parentId,
});

async function sentAgainThroughTheApi(): Promise<void> {
  const token = await tokenFor(fixture.member.presented.subject);
  const body = { operationId: randomUUID(), ...taskUnder(task.client1) };
  const before = await recordsNow();
  const lost = await post(api, '/api/b/alpha/task/create', body, authorised(token));
  const again = await post(api, '/api/b/alpha/task/create', body, authorised(token));
  expect(lost.status).toBe(200);
  expect(again.body['recordId']).toBe(lost.body['recordId']);
  expect(await recordsNow()).toBe(before + 1);
}

async function runAgainThroughTheCli(): Promise<void> {
  const token = await tokenFor(fixture.member.presented.subject);
  const answered: unknown[] = [];
  const cli = createCli({
    businessKey: 'alpha',
    credential: token,
    transport: async (path, sent, credential) => {
      const response = await through(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: sent,
      });
      answered.push(await response.clone().json());
      return response;
    },
  });
  const payload = { operationId: randomUUID(), ...taskUnder(task.client1) };
  const before = await recordsNow();
  await cli.run('task.create', payload);
  await cli.run('task.create', payload);
  expect(answered).toHaveLength(2);
  expect((answered[1] as { recordId?: unknown }).recordId).toBe(
    (answered[0] as { recordId?: unknown }).recordId,
  );
  expect(await recordsNow()).toBe(before + 1);
}

async function sentAgainThroughTheApp(): Promise<void> {
  const token = await tokenFor(fixture.member.presented.subject);
  const app = new OperationsClient({
    origin: '',
    businessKey: 'alpha',
    signedIn: true,
    fetch: asBrowser(token, async (url, init) => await through(url, init)),
  });
  const operationId = randomUUID();
  const body = taskUnder(task.client1);
  const before = await recordsNow();
  const first = await app.mutate('task.create' as never, body, { operationId });
  const second = await app.mutate('task.create' as never, body, { operationId });
  expect(second).toEqual(first);
  expect(await recordsNow()).toBe(before + 1);
}

describe.skipIf(server === undefined)('the client crossing task.create, surface by surface', () => {
  useIsolationWorld();

  it('a refused client-to-client task.create writes no task, refused by its own grant check on each surface', async () => {
    const row = rows.find((entry) => entry.command === 'task.create');
    if (row === undefined) throw new Error('task.create is missing from the catalogue');
    const before = await recordsNow();
    const answers = await threeWays(row, clientOne, 'alpha', { recordId: task.client2 });
    expect(await recordsNow()).toBe(before);
    expect(answers.map(({ code }) => code)).toEqual([
      'SCOPE_NOT_GRANTED',
      'SCOPE_NOT_GRANTED',
      'SCOPE_NOT_GRANTED',
    ]);
    const attempts = await attemptsBy(clientOne.actorId);
    expect(attempts.map(({ outcome, code }) => `${outcome} ${String(code)}`)).toEqual([
      'refused SCOPE_NOT_GRANTED',
      'refused SCOPE_NOT_GRANTED',
      'refused SCOPE_NOT_GRANTED',
    ]);
    expect(new Set(attempts.map(({ operation }) => operation)).size).toBe(3);
  });

  it(
    'a task.create whose answer is lost, sent again through the API under its operation id, files one task',
    sentAgainThroughTheApi,
  );

  it(
    'a task.create whose answer is lost, run again through the CLI under its operation id, files one task',
    runAgainThroughTheCli,
  );

  it(
    "a task.create whose answer is lost, sent again through the app's client under its operation id, files one task",
    sentAgainThroughTheApp,
  );
});
