// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 1 at 6f13be8, lane FR1-RUNTIME: #3, #4, #5 and #53.
//
// #3. `task.cancel` updated every planned or claimed run on its lineage after
// locking only the lineage, so a cancel racing `task.decide` (run before
// lineage) closed a lock cycle and one side met 40P01 as a 503. Both orders
// are forced here with a third connection holding the run row.
//
// #4. `task.decide` checked the decider's authority once, before its locks.
// A revocation that committed while the decision waited on the cap was never
// seen. Both orders are forced: a revocation that locks the grant first is
// seen under the locks and refused, and one that comes second waits for the
// decision to commit.
//
// #5. A pickup that fenced another reservation's expired lease on the task
// left that lease's hold counted until the next restart replay.
//
// #53. A `note` carrying NUL or a lone surrogate reached the signed payload's
// jsonb cast and raised, which answered 503 for a request that can never
// succeed.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import { connect, type Database } from '../../packages/core-records/src/tenancy/database.ts';
import { executeRead } from '../../packages/core-records/src/reads/execute.ts';
import { executeAgentCommand } from '../../packages/core-records/src/commands/agent-envelope.ts';
import { executeCommand } from '../../packages/core-records/src/commands/envelope.ts';
import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import {
  authorised,
  createBusinessResolver,
  post,
  SECRET,
  tokenFor,
  type Answer,
} from '../api/fixture.ts';
import { replayRecordedTransitions } from '../../packages/core-runtime/src/recovery.ts';
import {
  createControls,
  detailOf,
  personPath,
  PROPOSAL,
  type Controls,
} from '../api/controls-fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's connection to the controls database, which holds rows open and watches waiters. */
function ownerOf(c: Controls): postgres.Sql {
  const url = new URL(serverUrl as string);
  url.pathname = `/${c.fixture.db.name}`;
  return postgres(url.toString(), { max: 2, onnotice: () => undefined });
}

/**
 * A second API on its own one-connection pool. The controls API has one
 * connection, so a second request through it queues in the pool rather than
 * on a row lock, and the schedule never forms in the database.
 */
interface Second {
  asPerson(name: string, body: Readonly<Record<string, unknown>>, as: Member): Promise<Answer>;
  close(): Promise<void>;
}

function secondOf(c: Controls): Second {
  const database: Database = connect(c.fixture.db.appUrl, { source: 'runtime' });
  const api: Hono = createApi({
    database,
    verify: createSupabaseVerifier({ secret: SECRET }),
    resolveBusiness: createBusinessResolver(c.fixture.db.admin),
    executeCommand,
    executeRead,
    executeAgentCommand,
  });
  return {
    asPerson: async (name, body, as) =>
      await post(
        api,
        personPath(name),
        { operationId: randomUUID(), ...body },
        authorised(await tokenFor(as.presented.subject)),
      ),
    close: async () => {
      await database.close();
    },
  };
}

/** Waits until `count` backends in this database are waiting on a lock. */
async function waitersReach(owner: postgres.Sql, count: number): Promise<void> {
  for (let tries = 0; tries < 200; tries += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await owner<{ n: string }[]>`
      select count(*)::text as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock'`;
    if (Number(rows[0]?.n) >= count) return;
    // eslint-disable-next-line no-await-in-loop
    await sleep(25);
  }
  throw new Error(`fewer than ${String(count)} backends ever waited on a lock`);
}

const noop = (): void => undefined;

/** A transaction on the owner's connection that holds `statements`' rows until released. */
function hold(
  owner: postgres.Sql,
  statements: (sql: postgres.TransactionSql) => Promise<void>,
  then?: (sql: postgres.TransactionSql) => Promise<void>,
): { readonly done: Promise<unknown>; readonly release: () => void } {
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = owner.begin(async (sql) => {
    await statements(sql);
    await released;
    if (then !== undefined) await then(sql);
  });
  return { done, release };
}

/** Runs `schedule` while `blocker` is open, and always releases it, so a failed wait cannot hang teardown. */
async function whileHeld<T>(
  blocker: { readonly done: Promise<unknown>; readonly release: () => void },
  schedule: () => Promise<T>,
): Promise<T> {
  try {
    return await schedule();
  } finally {
    blocker.release();
    await blocker.done;
  }
}

async function capIdOf(c: Controls): Promise<string> {
  const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
    `select id from public.budget_caps where business_id = $1`,
    [c.fixture.business],
  );
  return String(rows[0]?.id);
}

const decideBody = (proposal: Record<string, unknown>, decision: string, note = 'decided') => ({
  gateId: proposal['gateId'],
  versionId: proposal['versionId'],
  decision,
  note,
});

describe.skipIf(serverUrl === undefined)('#3 task.cancel racing task.decide', () => {
  let c: Controls;
  let owner: postgres.Sql;
  let second: Second;

  beforeAll(async () => {
    c = await createControls('fr1c');
    owner = ownerOf(c);
    second = secondOf(c);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await second?.close();
    await c?.drop();
  });

  async function pendingLineage(title: string) {
    const task = await c.createTask(title);
    const proposal = await c.propose(task.id, task.revision);
    const runs = await c.fixture.db.admin.execute<{ readonly run_id: string }>(
      `select run_id from public.gates where id = $1`,
      [proposal['gateId']],
    );
    return { task, proposal, runId: String(runs[0]?.run_id) };
  }

  it('decide parked on the run first: both answer, and the cancel classifies the new hold', async () => {
    const { task, proposal, runId } = await pendingLineage('decide parked before a cancel');
    const blocker = hold(owner, async (sql) => {
      await sql`select 1 from public.planned_runs where id = ${runId} for update`;
    });
    const [deciding, cancelling] = await whileHeld(blocker, async () => {
      await sleep(50);

      const decidingRequest = c.asPerson('task.decide', decideBody(proposal, 'approve'));
      await waitersReach(owner, 1);
      const cancellingRequest = second.asPerson(
        'task.cancel',
        {
          recordId: task.id,
          lineageId: proposal['lineageId'],
          reason: 'cancelled while it was being decided',
        },
        c.manager,
      );
      await waitersReach(owner, 2);
      return [decidingRequest, cancellingRequest] as const;
    });

    const [decided, cancelled] = await Promise.all([deciding, cancelling]);
    expect([decided.status, decided.body['code']]).toStrictEqual([200, undefined]);
    expect([cancelled.status, cancelled.body['code']]).toStrictEqual([200, undefined]);
    const reservation = await c.fixture.db.admin.execute<{
      readonly state: string;
      readonly classified_cause: string | null;
    }>(`select state, classified_cause from public.reservations where id = $1`, [
      detailOf(decided)['reservationId'],
    ]);
    expect(reservation).toEqual([{ state: 'abandoned', classified_cause: 'lineage_cancelled' }]);
    expect(
      await c.count(
        `select count(*)::text as n from public.task_envelopes where task_id = $1 and held_minor = 0`,
        [task.id],
      ),
    ).toBe(1);
  }, 60_000);

  it('cancel parked on the run first: the cancel applies and the decide is LINEAGE_TERMINAL', async () => {
    const { task, proposal, runId } = await pendingLineage('cancel parked before a decide');
    const blocker = hold(owner, async (sql) => {
      await sql`select 1 from public.planned_runs where id = ${runId} for update`;
    });
    const [cancelling, deciding] = await whileHeld(blocker, async () => {
      await sleep(50);

      const cancellingRequest = c.asPerson('task.cancel', {
        recordId: task.id,
        lineageId: proposal['lineageId'],
        reason: 'cancelled before it was decided',
      });
      await waitersReach(owner, 1);
      const decidingRequest = second.asPerson(
        'task.decide',
        decideBody(proposal, 'approve'),
        c.manager,
      );
      await waitersReach(owner, 2);
      return [cancellingRequest, decidingRequest] as const;
    });

    const [cancelled, decided] = await Promise.all([cancelling, deciding]);
    expect([cancelled.status, cancelled.body['code']]).toStrictEqual([200, undefined]);
    expect(decided.body['code']).toBe('LINEAGE_TERMINAL');
    expect(
      await c.count(`select count(*)::text as n from public.gate_decisions where gate_id = $1`, [
        proposal['gateId'],
      ]),
    ).toBe(0);
  }, 60_000);
});

describe.skipIf(serverUrl === undefined)('#4 task.decide and a revocation of its grant', () => {
  let c: Controls;
  let owner: postgres.Sql;
  let second: Second;

  beforeAll(async () => {
    c = await createControls('fr1a');
    owner = ownerOf(c);
    second = secondOf(c);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await second?.close();
    await c?.drop();
  });

  /** A person whose only decide authority is one revocable grant. */
  async function decider(): Promise<{ readonly member: Member; readonly grantId: string }> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, `decider-${randomUUID()}`);
    let grantId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read');
      grantId = await grantTo(tx, member, 'decide');
    });
    return { member, grantId };
  }

  it('a revocation that locks the grant first is seen under the locks: SCOPE_NOT_GRANTED, nothing written', async () => {
    const task = await c.createTask('revoked while the decision waits');
    const proposal = await c.propose(task.id, task.revision);
    const { member, grantId } = await decider();
    const capId = await capIdOf(c);
    const blocker = hold(owner, async (sql) => {
      await sql`select 1 from public.grants where id = ${grantId} for update`;
      await sql`select 1 from public.budget_caps where id = ${capId} for update`;
    });
    const [revoking, deciding] = await whileHeld(blocker, async () => {
      await sleep(50);

      const revokingRequest = c.asPerson('grant.revoke', { grantId });
      await waitersReach(owner, 1);
      const decidingRequest = second.asPerson(
        'task.decide',
        decideBody(proposal, 'approve'),
        member,
      );
      await waitersReach(owner, 2);
      return [revokingRequest, decidingRequest] as const;
    });

    const [revoked, decided] = await Promise.all([revoking, deciding]);
    expect([revoked.status, revoked.body['code']]).toStrictEqual([200, undefined]);
    expect(decided.body['code']).toBe('SCOPE_NOT_GRANTED');
    expect(
      await c.count(`select count(*)::text as n from public.gate_decisions where gate_id = $1`, [
        proposal['gateId'],
      ]),
    ).toBe(0);
    expect(
      await c.count(
        `select count(*)::text as n from public.gates where id = $1 and state = 'pending'`,
        [proposal['gateId']],
      ),
    ).toBe(1);
  }, 60_000);

  it('a revocation that comes second waits for the decision to commit', async () => {
    const task = await c.createTask('decided while a revocation arrives');
    const proposal = await c.propose(task.id, task.revision);
    const { member, grantId } = await decider();
    const capId = await capIdOf(c);
    const blocker = hold(owner, async (sql) => {
      await sql`select 1 from public.budget_caps where id = ${capId} for update`;
    });
    const [deciding, revoking] = await whileHeld(blocker, async () => {
      await sleep(50);

      const decidingRequest = c.asPerson('task.decide', decideBody(proposal, 'approve'), member);
      await waitersReach(owner, 1);
      let revokeSettled = false;
      const revokingRequest = second
        .asPerson('grant.revoke', { grantId }, c.manager)
        .finally(() => {
          revokeSettled = true;
        });
      await sleep(300);
      // The revocation is parked on the grant row the decision holds for share.
      expect(revokeSettled).toBe(false);
      return [decidingRequest, revokingRequest] as const;
    });

    const [decided, revoked] = await Promise.all([deciding, revoking]);
    expect([decided.status, decided.body['code']]).toStrictEqual([200, undefined]);
    expect([revoked.status, revoked.body['code']]).toStrictEqual([200, undefined]);
    // The signed record never shows a decision made after its authority ended.
    expect(
      await c.count(
        `select count(*)::text as n from public.gate_decisions d, public.grants g
          where d.gate_id = $1 and g.id = $2 and d.decided_at < g.revoked_at`,
        [proposal['gateId'], grantId],
      ),
    ).toBe(1);
  }, 60_000);
});

describe.skipIf(serverUrl === undefined)(
  "#5 pickup fencing another reservation's expired lease",
  () => {
    let c: Controls;

    beforeAll(async () => {
      c = await createControls('fr1p');
    }, 120_000);

    afterAll(async () => {
      await c?.drop();
    });

    async function approved(
      taskId: string,
      maximumMinor: number,
      purpose: string,
    ): Promise<string> {
      const revision = await c.count(
        `select revision::text as n from public.records where id = $1`,
        [taskId],
      );
      const proposed = await c.asPerson('task.propose', {
        recordId: taskId,
        expectedRevision: revision,
        ...PROPOSAL,
        purpose,
        maximumMinor,
      });
      expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
      return await c.approve(detailOf(proposed));
    }

    it('classifies the fenced lease hold in the same transaction', async () => {
      const task = await c.createTask('one task, two approved lineages, one lease left to expire');
      // The first approval opens the envelope; its handback leaves the envelope open.
      const first = await c.pickup(await approved(task.id, 2_500, 'draft_the_reply'));
      const settled = await c.asAgent(
        'task.handback',
        {
          leaseId: first['leaseId'],
          fence: first['fence'],
          outcome: 'completed',
          report: { wrote: 'the first draft' },
        },
        String(first['credential']),
      );
      expect(settled.status, JSON.stringify(settled.body)).toBe(200);

      const one = await approved(task.id, 1_000, 'fr1_lineage_a');
      const two = await approved(task.id, 1_000, 'fr1_lineage_b');
      const leased = await c.pickup(one);
      await c.fixture.db.admin.execute(
        `update public.leases set expires_at = now() - interval '1 second' where id = $1`,
        [leased['leaseId']],
      );

      const picked = await c.asAgent('task.pickup', { reservationId: two });
      expect(picked.status, JSON.stringify(picked.body)).toBe(200);

      const rows = await c.fixture.db.admin.execute<{
        readonly state: string;
        readonly classified_cause: string | null;
        readonly classified_cause_id: string | null;
      }>(
        `select state, classified_cause, classified_cause_id from public.reservations where id = $1`,
        [one],
      );
      expect(rows).toEqual([
        {
          state: 'abandoned',
          classified_cause: 'lease_expired_and_fenced',
          classified_cause_id: leased['leaseId'],
        },
      ]);
      expect(
        await c.count(
          `select held_minor::text as n from public.task_envelopes where task_id = $1`,
          [task.id],
        ),
      ).toBe(1_000);
      const replayed = await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) =>
        replayRecordedTransitions(tx),
      );
      expect(replayed).toStrictEqual([]);
    }, 60_000);
  },
);

describe.skipIf(serverUrl === undefined)('#53 task.decide note values', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('fr1n');
  }, 120_000);

  afterAll(async () => {
    await c?.drop();
  });

  it.each([
    ['a NUL', `a${String.fromCodePoint(0)}b`],
    ['a lone surrogate', '\ud800'],
    ['a number', 5],
  ])(
    'refuses %s as FIELD_VALUE_INVALID, writes nothing and audits a refusal',
    async (_, note) => {
      const task = await c.createTask('a decision with a bad note');
      const proposal = await c.propose(task.id, task.revision);
      const operationId = randomUUID();
      const answer = await c.asPerson('task.decide', {
        ...decideBody(proposal, 'approve'),
        note,
        operationId,
      });
      expect([answer.status, answer.body['code']]).toStrictEqual([422, 'FIELD_VALUE_INVALID']);
      expect(JSON.stringify(answer.body)).toContain('note');
      expect(
        await c.count(`select count(*)::text as n from public.gate_decisions where gate_id = $1`, [
          proposal['gateId'],
        ]),
      ).toBe(0);
      expect(
        await c.count(
          `select count(*)::text as n from public.gates where id = $1 and state = 'pending'`,
          [proposal['gateId']],
        ),
      ).toBe(1);
      const events = await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) =>
        (await readAuditEvents(tx)).filter((event) => event.operation_id === operationId),
      );
      expect(events.map((event) => event.outcome)).toStrictEqual(['refused']);
    },
    60_000,
  );
});
