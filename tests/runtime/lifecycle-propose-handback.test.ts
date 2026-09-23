// SPDX-License-Identifier: AGPL-3.0-only
//
// F1 (runtime review at 74d583c): `task.propose` and `task.handback` on the
// same task cannot deadlock.
//
// TRANSACTION-CONTRACT line 9: discover first, then take cap, envelope, task
// and the rest in that order. At 74d583c the command adapter locked the task
// for `task.propose` before the runtime took the cap and envelope, while
// handback takes cap, envelope, then task. The schedule below forces the
// reviewer's interleaving through the real HTTP command entry: a third
// transaction holds the task row, the proposal queues first, the handback
// takes the cap and envelope and queues second, and the task is released.
// With the adapter lock, the proposal then holds the task and waits for the
// cap the handback holds, and Postgres aborts one of them with 40P01.
//
// One API process serves on one connection (`database.ts` opens `max: 1`), so
// the two requests go through two composed boundaries on two connections:
// two API processes over one database, which is the deployment that can race.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { createApi, type AgentExecutor, type ReadExecutor } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { authorised, createBusinessResolver, post, SECRET, tokenFor } from '../api/fixture.ts';
import { agentPath, createControls, PROPOSAL, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('propose racing handback on one task', () => {
  let c: Controls;
  let blocker: postgres.Sql;
  let second: Database;
  let secondApi: Hono;

  beforeAll(async () => {
    c = await createControls('lcf1');
    second = connect(c.fixture.db.appUrl, { source: 'runtime' });
    secondApi = createApi({
      database: second,
      verify: createSupabaseVerifier({ secret: SECRET }),
      resolveBusiness: createBusinessResolver(c.fixture.db.admin),
      executeRead: executeRead as unknown as ReadExecutor,
      executeAgentCommand: executeAgentCommand as unknown as AgentExecutor,
    });
    const url = new URL(serverUrl as string);
    url.pathname = `/${c.fixture.db.name}`;
    blocker = postgres(url.toString(), { max: 2, onnotice: () => undefined });
  }, 120_000);

  afterAll(async () => {
    await blocker?.end();
    await second?.close();
    await c?.drop();
  });

  /** Waits until `count` backends in this database are waiting on a lock. */
  async function waitersReach(count: number): Promise<void> {
    for (let tries = 0; tries < 200; tries += 1) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await blocker<{ n: string }[]>`
        select count(*)::text as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`;
      if (Number(rows[0]?.n) >= count) return;
      // eslint-disable-next-line no-await-in-loop
      await sleep(25);
    }
    throw new Error(`fewer than ${count} backends ever waited on a lock`);
  }

  it('completes both without a deadlock', async () => {
    const task = await c.createTask('a task proposed on while its work is handed back');
    const first = await c.propose(task.id, task.revision);
    const picked = await c.pickup(await c.approve(first));

    const gate: { release?: () => void } = {};
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const holding = blocker.begin(async (sql) => {
      await sql`select 1 from public.records where id = ${task.id} for update`;
      await released;
    });
    // The blocker's lock is taken before either request starts.
    await sleep(100);

    const proposing = c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: task.revision,
      ...PROPOSAL,
      purpose: 'a_second_line',
    });
    await waitersReach(1);
    const handing = post(
      secondApi,
      agentPath('task.handback'),
      {
        operationId: randomUUID(),
        leaseId: picked['leaseId'],
        fence: picked['fence'],
        outcome: 'completed',
        report: { note: 'done' },
      },
      {
        ...authorised(await tokenFor(c.fixture.agent.subject)),
        'x-agent-delegation': String(picked['credential']),
      },
    );
    await waitersReach(2);
    gate.release?.();
    await holding;

    const [proposed, handed] = await Promise.all([proposing, handing]);
    expect([proposed.status, proposed.body['code']]).toStrictEqual([200, undefined]);
    expect([handed.status, handed.body['code']]).toStrictEqual([200, undefined]);
  }, 60_000);
});
