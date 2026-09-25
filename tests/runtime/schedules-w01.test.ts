// SPDX-License-Identifier: AGPL-3.0-only
//
// W01: the atomic decision, interrupted at commit and retried.
//
// The ledger row: "Kill before commit: none; kill after commit: same receipt on
// retry; no duplicate hold". The existing interruption case
// (`lease.test.ts`, "leaves nothing behind when the decision transaction is
// interrupted") throws inside the transaction and catches the exception, which
// shows a rollback but not a lost connection and not a retry. Here the
// approval goes through the production command entry on a connection routed
// through a relay that kills the connection at a named point:
//
// - **before commit**, the client's `commit` never reaches the server, which
//   rolls back an open transaction whose writes were all made;
// - **after commit**, the server commits and its acknowledgement never reaches
//   the caller, which sees only a dead connection.
//
// Each time the caller must not have been told the decision applied, the
// durable state must be exactly the before-state or exactly one decision, and
// a retry under the **same operation identity** must land on one decision, one
// reservation, one attempt and one hold — a fresh application after the
// rollback, the saved receipt after the commit.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { readAuditEvents } from '../../packages/core-records/src/commands/audit.ts';
import type { CommandResult } from '../../packages/core-records/src/commands/register-store.ts';
import {
  approveBody,
  asPerson,
  capCommitted,
  createTask,
  cutProxy,
  openSchedules,
  propose,
  racer,
  scalar,
  type CutPoint,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/schedules-w01: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

const HOLD = 2_500;

interface Durable {
  readonly decisions: number;
  readonly reservations: number;
  readonly attempts: number;
  readonly envelopes: number;
  readonly held: number;
  readonly gateState: string;
  readonly operations: number;
  readonly committed: number;
}

describe.skipIf(serverUrl === undefined)(
  'W01: decision interrupted at commit, then retried',
  () => {
    let s: Schedules;

    beforeAll(async () => {
      s = await openSchedules('w01', 100_000);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    async function durable(
      taskId: string,
      proposal: Detail,
      operationId: string,
    ): Promise<Durable> {
      const gate = await s.db.admin.execute<{ readonly state: string }>(
        `select state from public.gates where business_id = $1 and id = $2`,
        [s.business, proposal['gateId']],
      );
      return {
        decisions: await scalar(
          s,
          `select count(*)::text as n from public.gate_decisions where business_id = $1 and gate_id = $2`,
          [s.business, proposal['gateId']],
        ),
        reservations: await scalar(
          s,
          `select count(*)::text as n from public.reservations where business_id = $1 and version_id = $2`,
          [s.business, proposal['versionId']],
        ),
        attempts: await scalar(
          s,
          `select count(*)::text as n from public.attempts where business_id = $1 and version_id = $2`,
          [s.business, proposal['versionId']],
        ),
        envelopes: await scalar(
          s,
          `select count(*)::text as n from public.task_envelopes where business_id = $1 and task_id = $2`,
          [s.business, taskId],
        ),
        held: await scalar(
          s,
          `select coalesce(sum(held_minor), 0)::text as n from public.task_envelopes
          where business_id = $1 and task_id = $2`,
          [s.business, taskId],
        ),
        gateState: gate[0]?.state ?? 'missing',
        operations: await scalar(
          s,
          `select count(*)::text as n from public.operations where business_id = $1 and operation_id = $2`,
          [s.business, operationId],
        ),
        committed: await capCommitted(s),
      };
    }

    async function auditOutcomes(operationId: string): Promise<readonly string[]> {
      return await s.db.app.withBusiness(s.business, async (tx) => {
        const events = await readAuditEvents(tx);
        return events.filter((event) => event.operation_id === operationId).map((e) => e.outcome);
      });
    }

    /** Approve through a relay that kills the connection at `point`; the caller's view. */
    async function interruptedApproval(
      body: Readonly<Record<string, unknown>>,
      point: CutPoint,
    ): Promise<PromiseSettledResult<CommandResult>> {
      const proxy = await cutProxy(s.db.appUrl, point);
      const database = racer(s, proxy.url);
      try {
        const [outcome] = await Promise.allSettled([asPerson(s, body, database)]);
        expect(proxy.cut(), `the relay never reached its ${point} point`).toBe(true);
        return outcome as PromiseSettledResult<CommandResult>;
      } finally {
        await database.close().catch(() => undefined);
        await proxy.close();
      }
    }

    it('kill before commit: nothing durable, no success reported, and the retry applies once', async () => {
      const taskId = await createTask(s, 'interrupted before commit');
      const proposal = await propose(s, taskId, { maximumMinor: HOLD });
      const body = approveBody(proposal);
      const operationId = String(body['operationId']);
      const before = await durable(taskId, proposal, operationId);
      expect(before).toMatchObject({
        decisions: 0,
        reservations: 0,
        attempts: 0,
        gateState: 'pending',
      });

      const interrupted = await interruptedApproval(body, 'before-commit');
      // No reported success on a rollback: the caller got an error, not a result.
      expect(interrupted.status).toBe('rejected');
      expect(await durable(taskId, proposal, operationId)).toStrictEqual(before);
      // The envelope records the failure in a transaction of its own
      // (`envelope.ts`, outcome `failed`), and never an application.
      expect(await auditOutcomes(operationId)).toStrictEqual(['failed']);

      // The same operation identity, retried: nothing was recorded under it, so
      // it applies for the first time.
      const retried = await asPerson(s, body);
      expect(isCommandRefusal(retried)).toBe(false);
      const after = await durable(taskId, proposal, operationId);
      expect(after).toStrictEqual({
        ...before,
        decisions: 1,
        reservations: 1,
        attempts: 1,
        envelopes: 1,
        held: HOLD,
        gateState: 'approved',
        operations: 1,
        committed: before.committed + HOLD,
      });
      expect(await auditOutcomes(operationId)).toStrictEqual(['failed', 'applied']);

      // And again: the receipt, not a second hold.
      const again = await asPerson(s, body);
      expect(again).toStrictEqual(retried);
      expect(await durable(taskId, proposal, operationId)).toStrictEqual(after);
    });

    it('kill after commit: one decision durable, and the retry returns the same receipt with no second hold', async () => {
      const taskId = await createTask(s, 'interrupted after commit');
      const proposal = await propose(s, taskId, { maximumMinor: HOLD });
      const body = approveBody(proposal);
      const operationId = String(body['operationId']);
      const before = await durable(taskId, proposal, operationId);
      expect(before).toMatchObject({
        decisions: 0,
        reservations: 0,
        attempts: 0,
        gateState: 'pending',
      });

      const interrupted = await interruptedApproval(body, 'after-commit');
      // The server committed, and the caller was never told so.
      expect(interrupted.status).toBe('rejected');
      const committed = await durable(taskId, proposal, operationId);
      expect(committed).toStrictEqual({
        ...before,
        decisions: 1,
        reservations: 1,
        attempts: 1,
        envelopes: 1,
        held: HOLD,
        gateState: 'approved',
        operations: 1,
        committed: before.committed + HOLD,
      });
      // The application committed; the caller's lost connection is recorded as
      // a failure beside it, which is what the caller saw.
      expect(await auditOutcomes(operationId)).toStrictEqual(['applied', 'failed']);

      // The same operation identity, retried: the saved receipt, and nothing new.
      const retried = await asPerson(s, body);
      expect(isCommandRefusal(retried)).toBe(false);
      if (isCommandRefusal(retried)) throw new Error('unreachable');
      const saved = await s.db.admin.execute<{ readonly result: { readonly detail: Detail } }>(
        `select result from public.operations where business_id = $1 and operation_id = $2`,
        [s.business, operationId],
      );
      expect(retried.detail).toStrictEqual(saved[0]?.result.detail);
      expect((retried.detail as Detail)['reservationId']).toBeDefined();
      expect(await durable(taskId, proposal, operationId)).toStrictEqual(committed);
      expect(await auditOutcomes(operationId)).toStrictEqual(['applied', 'failed', 'replayed']);
    });
  },
);
