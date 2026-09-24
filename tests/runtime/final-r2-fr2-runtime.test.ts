// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 2 at 3eb0cc1, lane FR2-RUNTIME. Each case was run red at
// 3eb0cc1 before its fix (PROVE-BEFORE-FIX).
//
// R2-RUNTIME-4. `task.decide` re-checked its decide grant under the locks, but
// through `now()`, the transaction's start, so a grant that lapsed while the
// decision waited on the cap still approved.
//
// R2-RUNTIME-5. `task.cancel` checked write once, before its locks, and held
// no grant, so a revocation that committed while it waited did not stop it.
//
// R2-RUNTIME-7. `task.decide` approved a gate on a trashed task, holding
// budget for work that is never handed out.
//
// R2-AUTHORITY-33. An upper-case spelling of a valid id was refused by a
// string comparison after the uuid cast had already found the row.
//
// R2-RUNTIME-14. `task.start` on a completed task cleared the completion stamp
// without `task.reopen` and its reason.
//
// R2-RUNTIME-51. `task.reopen` applied with a missing, empty or non-string
// reason.

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
import {
  authorised,
  createBusinessResolver,
  post,
  SECRET,
  tokenFor,
  type Answer,
} from '../api/fixture.ts';
import { createControls, detailOf, personPath, type Controls } from '../api/controls-fixture.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

/** The owner's connection to the controls database, which holds rows open and watches waiters. */
function ownerOf(c: Controls): postgres.Sql {
  const url = new URL(serverUrl as string);
  url.pathname = `/${c.fixture.db.name}`;
  return postgres(url.toString(), { max: 2, onnotice: () => undefined });
}

/** A second API on its own pool, so a second request queues on a row lock and not in the pool. */
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
): { readonly done: Promise<unknown>; readonly release: () => void } {
  let release: () => void = noop;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const done = owner.begin(async (sql) => {
    await statements(sql);
    await released;
  });
  return { done, release };
}

/** Runs `schedule` while `blocker` is open, and always releases it. */
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

const decideBody = (proposal: Record<string, unknown>, decision: string) => ({
  gateId: proposal['gateId'],
  versionId: proposal['versionId'],
  decision,
  note: 'decided',
});

describe.skipIf(serverUrl === undefined)('FR2-RUNTIME: final review round 2', () => {
  let c: Controls;
  let owner: postgres.Sql;
  let second: Second;

  beforeAll(async () => {
    c = await createControls('fr2r');
    owner = ownerOf(c);
    second = secondOf(c);
  }, 120_000);

  afterAll(async () => {
    await owner?.end();
    await second?.close();
    await c?.drop();
  });

  async function capId(): Promise<string> {
    const rows = await c.fixture.db.admin.execute<{ readonly id: string }>(
      `select id from public.budget_caps where business_id = $1`,
      [c.fixture.business],
    );
    return String(rows[0]?.id);
  }

  async function revisionOf(taskId: string): Promise<number> {
    const rows = await c.fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [taskId],
    );
    return Number(rows[0]?.revision);
  }

  /** A person whose only `action` authority on tasks is one grant, plus read. */
  async function holderOf(action: 'decide' | 'write'): Promise<{
    readonly member: Member;
    readonly grantId: string;
  }> {
    const member = await enrol(c.fixture.db.app, c.fixture.business, `${action}-${randomUUID()}`);
    let grantId = '';
    await c.fixture.db.app.withBusiness(c.fixture.business, async (tx) => {
      await grantTo(tx, member, 'read');
      grantId = await grantTo(tx, member, action);
    });
    return { member, grantId };
  }

  const gateDecisions = async (gateId: unknown): Promise<number> =>
    await c.count(`select count(*)::text as n from public.gate_decisions where gate_id = $1`, [
      gateId,
    ]);

  describe('R2-RUNTIME-4 a decide grant that lapses while the decision waits', () => {
    it('is judged at the locked instant: SCOPE_NOT_GRANTED, nothing written', async () => {
      const task = await c.createTask('grant lapses under the cap');
      const proposal = await c.propose(task.id, task.revision);
      const { member, grantId } = await holderOf('decide');
      await c.fixture.db.admin.execute(
        `update public.grants set expires_at = clock_timestamp() + interval '2 seconds'
          where id = $1`,
        [grantId],
      );
      const cap = await capId();
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.budget_caps where id = ${cap} for update`;
      });
      // A tuple, not the promise itself: an async function returning a promise
      // adopts it, and `whileHeld` would wait for the decision it is blocking.
      const [deciding] = await whileHeld(blocker, async () => {
        await sleep(50);
        const request = second.asPerson('task.decide', decideBody(proposal, 'approve'), member);
        await waitersReach(owner, 1);
        // Past the grant's expiry, while the decision is parked on the cap.
        await sleep(2_500);
        return [request] as const;
      });

      const decided = await deciding;
      expect(decided.body['code'], JSON.stringify(decided.body)).toBe('SCOPE_NOT_GRANTED');
      expect(await gateDecisions(proposal['gateId'])).toBe(0);
      expect(
        await c.count(
          `select count(*)::text as n from public.gates where id = $1 and state = 'pending'`,
          [proposal['gateId']],
        ),
      ).toBe(1);
      expect(
        await c.count(`select count(*)::text as n from public.task_envelopes where task_id = $1`, [
          task.id,
        ]),
      ).toBe(0);
    }, 60_000);
  });

  describe('R2-RUNTIME-5 task.cancel and a revocation of the canceller’s write', () => {
    async function pendingLineage(title: string) {
      const task = await c.createTask(title);
      const proposal = await c.propose(task.id, task.revision);
      const runs = await c.fixture.db.admin.execute<{ readonly run_id: string }>(
        `select run_id from public.gates where id = $1`,
        [proposal['gateId']],
      );
      return { task, proposal, runId: String(runs[0]?.run_id) };
    }

    const lineageState = async (lineageId: unknown) =>
      await c.fixture.db.admin.execute<{ readonly state: string; readonly terminal_at: unknown }>(
        `select state, terminal_at from public.proposal_lineages where id = $1`,
        [lineageId],
      );

    it('a revocation that locks the grant first is seen under the locks: SCOPE_NOT_GRANTED', async () => {
      const { task, proposal, runId } = await pendingLineage('revoked while the cancel waits');
      const { member, grantId } = await holderOf('write');
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.grants where id = ${grantId} for update`;
        await sql`select 1 from public.planned_runs where id = ${runId} for update`;
      });
      const [revoking, cancelling] = await whileHeld(blocker, async () => {
        await sleep(50);
        const revokingRequest = c.asPerson('grant.revoke', { grantId });
        await waitersReach(owner, 1);
        const cancellingRequest = second.asPerson(
          'task.cancel',
          { recordId: task.id, lineageId: proposal['lineageId'], reason: 'stand down' },
          member,
        );
        await waitersReach(owner, 2);
        return [revokingRequest, cancellingRequest] as const;
      });

      const [cancelled, revoked] = await Promise.all([cancelling, revoking]);
      expect([revoked.status, revoked.body['code']]).toStrictEqual([200, undefined]);
      expect(cancelled.body['code'], JSON.stringify(cancelled.body)).toBe('SCOPE_NOT_GRANTED');
      expect(await lineageState(proposal['lineageId'])).toEqual([
        { state: 'live', terminal_at: null },
      ]);
    }, 60_000);

    it('a revocation that comes second waits for the cancellation to commit', async () => {
      const { task, proposal, runId } = await pendingLineage(
        'cancelled while a revocation arrives',
      );
      const { member, grantId } = await holderOf('write');
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.planned_runs where id = ${runId} for update`;
      });
      const [cancelling, revoking] = await whileHeld(blocker, async () => {
        await sleep(50);
        const cancellingRequest = second.asPerson(
          'task.cancel',
          { recordId: task.id, lineageId: proposal['lineageId'], reason: 'stand down' },
          member,
        );
        await waitersReach(owner, 1);
        let revokeSettled = false;
        const revokingRequest = c.asPerson('grant.revoke', { grantId }).finally(() => {
          revokeSettled = true;
        });
        await sleep(300);
        // Parked on the grant row the cancellation holds for share.
        expect(revokeSettled).toBe(false);
        return [cancellingRequest, revokingRequest] as const;
      });

      const [cancelled, revoked] = await Promise.all([cancelling, revoking]);
      expect([cancelled.status, cancelled.body['code']]).toStrictEqual([200, undefined]);
      expect([revoked.status, revoked.body['code']]).toStrictEqual([200, undefined]);
      expect(
        await c.count(
          `select count(*)::text as n from public.proposal_lineages l, public.grants g
            where l.id = $1 and g.id = $2 and l.terminal_at < g.revoked_at`,
          [proposal['lineageId'], grantId],
        ),
      ).toBe(1);
    }, 60_000);
  });

  describe('R2-RUNTIME-7 task.decide on a trashed task', () => {
    const envelopes = async (taskId: string): Promise<number> =>
      await c.count(`select count(*)::text as n from public.task_envelopes where task_id = $1`, [
        taskId,
      ]);

    it('answers NOT_FOUND in the bytes of an unknown gate, and writes nothing', async () => {
      const task = await c.createTask('decided after trash');
      const proposal = await c.propose(task.id, task.revision);
      const trashed = await c.asPerson('task.trash', {
        recordId: task.id,
        expectedRevision: await revisionOf(task.id),
      });
      expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);

      const decided = await c.asPerson('task.decide', decideBody(proposal, 'approve'));
      const unknown = await c.asPerson('task.decide', {
        ...decideBody(proposal, 'approve'),
        gateId: randomUUID(),
      });
      expect(decided.status, JSON.stringify(decided.body)).toBe(404);
      expect(decided.body).toStrictEqual(unknown.body);
      expect(await gateDecisions(proposal['gateId'])).toBe(0);
      expect(await envelopes(task.id)).toBe(0);
    }, 60_000);

    it('a trash that commits while the decision waits on the cap is seen under the locks', async () => {
      const task = await c.createTask('trashed while it is decided');
      const proposal = await c.propose(task.id, task.revision);
      const cap = await capId();
      const blocker = hold(owner, async (sql) => {
        await sql`select 1 from public.budget_caps where id = ${cap} for update`;
      });
      const [deciding] = await whileHeld(blocker, async () => {
        await sleep(50);
        const request = second.asPerson('task.decide', decideBody(proposal, 'approve'), c.manager);
        await waitersReach(owner, 1);
        const trashed = await c.asPerson('task.trash', {
          recordId: task.id,
          expectedRevision: await revisionOf(task.id),
        });
        expect(trashed.status, JSON.stringify(trashed.body)).toBe(200);
        return [request] as const;
      });

      const decided = await deciding;
      expect([decided.status, decided.body['code']], JSON.stringify(decided.body)).toStrictEqual([
        404,
        'NOT_FOUND',
      ]);
      expect(await gateDecisions(proposal['gateId'])).toBe(0);
      expect(await envelopes(task.id)).toBe(0);
    }, 60_000);
  });

  describe('R2-AUTHORITY-33 an upper-case spelling of a valid id', () => {
    it('task.cancel names the task and its lineage', async () => {
      const task = await c.createTask('cancel by upper-case id');
      const proposal = await c.propose(task.id, task.revision);
      const cancelled = await c.asPerson('task.cancel', {
        recordId: task.id.toUpperCase(),
        lineageId: String(proposal['lineageId']).toUpperCase(),
        reason: 'stand down',
      });
      expect([cancelled.status, cancelled.body['code']], JSON.stringify(cancelled.body)).toEqual([
        200,
        undefined,
      ]);
    }, 60_000);

    it('task.decide decides the gate’s own version', async () => {
      const task = await c.createTask('decide by upper-case version');
      const proposal = await c.propose(task.id, task.revision);
      const decided = await c.asPerson('task.decide', {
        ...decideBody(proposal, 'reject'),
        gateId: String(proposal['gateId']).toUpperCase(),
        versionId: String(proposal['versionId']).toUpperCase(),
      });
      expect([decided.status, decided.body['code']], JSON.stringify(decided.body)).toEqual([
        200,
        undefined,
      ]);
    }, 60_000);

    it('task.assign names a member here, stored in one spelling', async () => {
      const task = await c.createTask('assign by upper-case id');
      const assigned = await c.asPerson('task.assign', {
        recordId: task.id,
        expectedRevision: task.revision,
        fields: { assignee: c.manager.personId.toUpperCase() },
      });
      expect([assigned.status, assigned.body['code']], JSON.stringify(assigned.body)).toEqual([
        200,
        undefined,
      ]);
      const stored = await c.fixture.db.admin.execute<{ readonly assignee: string }>(
        `select data->>'assignee' as assignee from public.records where id = $1`,
        [task.id],
      );
      expect(stored).toEqual([{ assignee: c.manager.personId }]);
    }, 60_000);
  });

  describe('R2-RUNTIME-14 and R2-RUNTIME-51 the completion stamp has one clearer', () => {
    async function completed(title: string): Promise<{ id: string; revision: number }> {
      const task = await c.createTask(title);
      const done = await c.asPerson('task.complete', {
        recordId: task.id,
        expectedRevision: task.revision,
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      return { id: task.id, revision: Number(done.body['revision']) };
    }

    const stampOf = async (taskId: string) =>
      await c.fixture.db.admin.execute<{ readonly ts_2: unknown }>(
        `select ts_2 from public.records where id = $1`,
        [taskId],
      );

    it('R2-RUNTIME-14 task.start on a completed task is refused and the stamp stays', async () => {
      const task = await completed('started after completion');
      const before = await stampOf(task.id);
      expect(before[0]?.ts_2).not.toBeNull();
      const started = await c.asPerson('task.start', {
        recordId: task.id,
        expectedRevision: task.revision,
      });
      expect([started.status, started.body['code']], JSON.stringify(started.body)).toEqual([
        409,
        'TRANSITION_NOT_PERMITTED',
      ]);
      expect(await stampOf(task.id)).toEqual(before);
    }, 60_000);

    it.each([
      ['missing', {}],
      ['empty', { reason: '' }],
      ['blank', { reason: '   ' }],
      ['a number', { reason: 12 }],
      ['an object', { reason: { x: [1] } }],
      ['over 500 characters', { reason: 'r'.repeat(501) }],
    ])(
      'R2-RUNTIME-51 task.reopen with a reason that is %s is refused',
      async (_, extra) => {
        const task = await completed('reopened without a reason');
        const before = await stampOf(task.id);
        const reopened = await c.asPerson('task.reopen', {
          recordId: task.id,
          expectedRevision: task.revision,
          ...extra,
        });
        expect(
          [reopened.status, reopened.body['code'], reopened.body['names']],
          JSON.stringify(reopened.body),
        ).toEqual([422, 'FIELD_VALUE_INVALID', ['reason']]);
        expect(await stampOf(task.id)).toEqual(before);
      },
      60_000,
    );

    it('R2-RUNTIME-51 task.reopen with a reason still applies', async () => {
      const task = await completed('reopened with a reason');
      const reopened = await c.asPerson('task.reopen', {
        recordId: task.id,
        expectedRevision: task.revision,
        reason: 'the client came back',
      });
      expect([reopened.status, detailOf(reopened)['reason']]).toEqual([
        200,
        'the client came back',
      ]);
      expect(await stampOf(task.id)).toEqual([{ ts_2: null }]);
    }, 60_000);
  });
});
