// SPDX-License-Identifier: AGPL-3.0-only
//
// A budget top-up (T2e) sent again under its first operation id is made at
// most once, whenever its answer was lost. Lost before the commit: the
// top-up is cancelled while it waits on its cap lock, nothing is kept,
// and the same attempt sent again is made once. Lost after the commit: the
// same attempt sent again is answered as the top-up already made. Each
// attempt names its operation and its task in capitals, as a caller may, and
// is sent again exactly as it was first sent, so the register's comparison
// is of the identifiers as stored.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { holdRow, waiterOf } from '../support/lock-wait-race.ts';
import { codeOf, racer } from '../runtime/schedules-harness.ts';
import { MAXIMUM, SMALL, openTopUpWorld, type TopUpWorld } from '../runtime/t2e-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

let world: TopUpWorld;
const it = serverUrl === undefined ? vitestIt.skip : vitestIt;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  world = await openTopUpWorld('topuponce');
}, 180_000);

afterAll(async () => await world?.s.db.drop());

/** A top-up of a freshly planned task, its identifiers in capitals. */
const attempt = async () => {
  const { taskId } = await world.planned();
  const body = {
    command: 'budget.top_up',
    operationId: randomUUID().toUpperCase(),
    recordId: taskId.toUpperCase(),
    amountMinor: SMALL,
    fromMaximumMinor: MAXIMUM,
  } as const;
  return { taskId, body };
};

const send = async (body: Readonly<Record<string, unknown>>) =>
  await executeCommand(
    world.s.db.app,
    world.s.business,
    world.s.decider.presented,
    'api',
    body as never,
  );

it('a top-up cancelled while it waits on its cap is made once when sent again', async () => {
  const { taskId, body } = await attempt();
  const held = await holdRow(
    world.s.db,
    'select id from public.budget_caps where id = $1 for update',
    [world.s.capId],
  );
  const connection = racer(world.s);
  const topping = executeCommand(
    connection,
    world.s.business,
    world.s.decider.presented,
    'api',
    body as never,
  ).then(
    () => 'answered',
    () => 'lost',
  );
  try {
    await waiterOf(world.s.db, held);
    await world.s.db.admin.execute(
      `select pg_cancel_backend(a.pid) from pg_stat_activity a
        where a.datname = current_database() and $1::int = any(pg_blocking_pids(a.pid))`,
      [held.pid],
    );
    expect(await topping, 'the answer is lost before the commit').toBe('lost');
  } finally {
    await held.letGo();
    await connection.close();
  }
  expect(await world.maximumOf(taskId), 'nothing was kept').toBe(MAXIMUM);
  expect(codeOf(await send(body))).toBe('applied');
  expect(codeOf(await send(body))).toBe('applied');
  expect(await world.maximumOf(taskId), 'one durable top-up').toBe(MAXIMUM + SMALL);
}, 60_000);

it('a top-up whose answer is lost after its commit is answered as itself when sent again', async () => {
  const { taskId, body } = await attempt();
  const first = await send(body);
  expect(codeOf(first)).toBe('applied');
  const again = await send(body);
  expect(again, 'the register answers the top-up already made').toStrictEqual(first);
  expect(await world.maximumOf(taskId), 'one durable top-up').toBe(MAXIMUM + SMALL);
}, 60_000);
