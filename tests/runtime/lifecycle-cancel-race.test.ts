// SPDX-License-Identifier: AGPL-3.0-only
//
// N1 (W-SCHEDULES, coordinator 18): a cancellation that loses to a handback.
//
// Cancellation discovers its lineage's held reservations and live leases
// before any lock. If a handback commits between that discovery and the
// locks, the rediscovery under the locks finds fewer rows: the reservation is
// no longer held and the lease is no longer live. At 74d583c that raised a
// raw "affected set changed" fault, which reached the caller as a 500. The
// smaller set needs no lock the transaction does not already hold, so the
// cancellation continues with it; only a set that needs a new lock rolls back.
//
// The schedule: a third transaction holds the cap, the handback queues on it
// first, the cancellation discovers and queues second, the cap is released,
// the handback commits, and the cancellation takes its locks.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { authorised, createBusinessResolver, post, SECRET, tokenFor } from '../api/fixture.ts';
import { agentPath, createControls, type Controls } from '../api/controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('cancel losing to a handback on one lineage', () => {
  let c: Controls;
  let blocker: postgres.Sql;
  let second: Database;
  let secondApi: Hono;

  beforeAll(async () => {
    c = await createControls('lcn1');
    second = connect(c.fixture.db.appUrl, { source: 'runtime' });
    secondApi = createApi({
      database: second,
      verify: createSupabaseVerifier({ secret: SECRET }),
      resolveBusiness: createBusinessResolver(c.fixture.db.admin),
      executeCommand,
      executeRead,
      executeAgentCommand,
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

  it('cancels the lineage with the smaller set instead of faulting', async () => {
    const task = await c.createTask('a task cancelled while its work is handed back');
    const first = await c.propose(task.id, task.revision);
    const picked = await c.pickup(await c.approve(first));
    const capId = (
      await c.fixture.db.admin.execute<{ readonly cap_id: string }>(
        `select env.cap_id from public.task_envelopes env where env.task_id = $1`,
        [task.id],
      )
    )[0]?.cap_id;

    const gate: { release?: () => void } = {};
    const released = new Promise<void>((resolve) => {
      gate.release = resolve;
    });
    const holding = blocker.begin(async (sql) => {
      await sql`select 1 from public.budget_caps where id = ${capId ?? ''} for update`;
      await released;
    });
    await sleep(100);

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
    await waitersReach(1);
    const cancelling = c.asPerson('task.cancel', {
      recordId: task.id,
      lineageId: first['lineageId'],
      reason: 'cancelled while it was being handed back',
    });
    await waitersReach(2);
    gate.release?.();
    await holding;

    const [handed, cancelled] = await Promise.all([handing, cancelling]);
    expect([handed.status, handed.body['code']]).toStrictEqual([200, undefined]);
    expect([cancelled.status, cancelled.body['code']]).toStrictEqual([200, undefined]);
    expect(
      await c.count(
        `select count(*)::text as n from public.proposal_lineages where id = $1 and state = 'cancelled'`,
        [first['lineageId']],
      ),
    ).toBe(1);
    // The hold was released once, by the handback, and not again.
    expect(
      await c.count(
        `select count(*)::text as n from public.task_envelopes where task_id = $1 and held_minor = 0`,
        [task.id],
      ),
    ).toBe(1);
  }, 60_000);
});
