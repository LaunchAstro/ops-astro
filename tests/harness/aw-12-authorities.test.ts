// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-12 authorities at the runtime (TEST.md 2): A8 state transitions. The
// harness's database role, a login in the restricted worker role and the
// canary for any framework's, cannot update the run, its steps or its events.
// A1, A2 and A7 run on the real stack in
// `aw-12-the-agent-holds-no-task-approval-or-retry-authority.test.ts`, A3 to
// A5 in the broker file beside this one, A6 under kernel confinement.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it as vitestIt } from 'vitest';
import {
  connectAsAdmin,
  type AdminConnection,
} from '../../packages/core-records/src/tenancy/database.ts';
import { noDatabase, s, useFaultWorld } from '../broker/aw-10-world.ts';
import { liveWork, rows } from '../runtime/schedules-harness.ts';
import { runRecord } from './aw-12-authority-reads.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;

let harness: AdminConnection;
const login = `aw12_harness_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

// The broker world: work really picked up, custody's process and the replay provider.
useFaultWorld('aw12auth');

beforeAll(async () => {
  if (noDatabase) return;
  const password = randomUUID();
  await s.db.admin.execute(
    `create role ${login} login password '${password}' in role ops_astro_worker`,
  );
  // The harness's role: a login in the restricted worker role, the canary for any framework's.
  const address = new URL(s.db.appUrl);
  address.username = login;
  address.password = password;
  harness = connectAsAdmin(address.toString(), { source: 'aw-12-authorities' });
}, 60_000);

afterAll(async () => {
  await harness?.close();
  await s?.db.admin.execute(`drop role if exists ${login}`);
});

async function stateTransitions(): Promise<void> {
  const work = await liveWork(s, `aw12 role ${randomUUID()}`, 2_000);
  const [run] = await rows<{ id: string }>(
    s,
    `select run_id as id from public.leases where business_id = $1 and id = $2`,
    [s.business, work.picked['leaseId']],
  );
  const updates = [
    `update public.planned_runs set state = 'completed' where business_id = $1 and id = $2`,
    `update public.planned_steps set ordinal = ordinal where business_id = $1 and run_id = $2`,
    `update public.run_events set detail = '{}' where business_id = $1 and run_id = $2`,
  ];
  const before = await runRecord(run?.id);
  const codes = await Promise.all(
    updates.map(
      async (sql) =>
        await harness.execute(sql, [s.business, run?.id]).then(
          () => 'ran',
          (error: unknown) => String((error as { code?: unknown }).code),
        ),
    ),
  );
  expect(codes).toStrictEqual(['42501', '42501', '42501']);
  expect(await runRecord(run?.id)).toStrictEqual(before);
  // Control: a real statement on a real row; the application role, never the harness's, reaches it.
  const reached = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await tx.query(
        `update public.planned_runs set state = state where business_id = $1 and id = $2 returning id`,
        [s.business, run?.id],
      ),
  );
  expect(reached).toHaveLength(1);
}

describe(
  'AW-12 authorities: a framework holds none of the eight authorities',
  { timeout: 120_000 },
  () => {
    it(
      "A8 state transitions: the run record cannot be updated from the harness's database role",
      stateTransitions,
    );
  },
);
