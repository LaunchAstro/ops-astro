// SPDX-License-Identifier: AGPL-3.0-only
//
// Final review round 3 (61c167a), lane FR3-PROPOSE: `task.propose` through the
// person command entry, against a real database, proved before the fix (owner
// direction 24 Sep 2026).
//
// - SOL-R3-3, and the R2-RUNTIME-26 residual: the proposal preflight checked
//   the cap's currency and room but not the open envelope's own maximum. A
//   successor on an approved lineage asking more than the envelope holds, but
//   within the cap, was written with a pending gate that `task.decide`'s
//   `budgetRoom` then refuses, until it expired (TRANSACTION-CONTRACT T1,
//   "existing budget authority"; RUNTIME.md, `BUDGET_UNAVAILABLE` is the
//   envelope and `BUDGET_EXHAUSTED` the cap).
// - R3-AUTHORITY-20 (= R3-SURFACE-23 = R3-THERMO-27): that budget check ran
//   before LINEAGE_NOT_ON_TASK, so a lineage on another task was priced, its
//   hold showed through the refusal, and the code depended on the ceiling
//   (the R2-AUTHORITY-34 class; AUTHORITY.md, a lineage the caller cannot
//   reach gets the same bytes).
// - R3-AUTHORITY-19: an upper-case lineageId, the same uuid, faulted 503 at
//   the lineage lock-set check, where the lower-case one applies (R2-AUTHORITY-33).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import { databaseUrlFromEnvironment } from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import {
  approve,
  approveBody,
  asPerson,
  codeOf,
  createTask,
  freshPurpose,
  openSchedules,
  propose,
  proposeBody,
  revisionOf,
  rows,
  scalar,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/final-r3-propose: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)(
  'SOL-R3-3: task.propose checks the open envelope, not only the cap',
  () => {
    let s: Schedules;
    // The cap is shared by every task below and stays far from binding, so
    // each refusal here is the envelope's, not the cap's.
    const LIMIT = 100_000;
    const ENVELOPE = 4_000;

    beforeAll(async () => {
      s = await openSchedules('fr3_propose_envelope', LIMIT);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    async function versionsOn(taskId: string): Promise<number> {
      return await scalar(
        s,
        `select count(*)::text as n from public.proposal_versions ver
           join public.proposal_lineages lin
             on lin.business_id = ver.business_id and lin.id = ver.lineage_id
          where ver.business_id = $1 and lin.task_id = $2`,
        [s.business, taskId],
      );
    }

    async function pendingGatesOn(taskId: string): Promise<number> {
      return await scalar(
        s,
        `select count(*)::text as n from public.gates g
           join public.proposal_lineages lin
             on lin.business_id = g.business_id and lin.id = g.lineage_id
          where g.business_id = $1 and lin.task_id = $2 and g.state = 'pending'`,
        [s.business, taskId],
      );
    }

    async function envelopeMaximum(taskId: string): Promise<string | undefined> {
      const found = await rows<{ maximum_minor: string }>(
        s,
        `select maximum_minor::text as maximum_minor from public.task_envelopes
          where business_id = $1 and task_id = $2 and state = 'open'`,
        [s.business, taskId],
      );
      return found[0]?.maximum_minor;
    }

    /**
     * Propose on `taskId`, and when that applied, ask for the approval its gate
     * was written for. A gate the proposal wrote and the approval refuses is
     * the defect: the answer, what was written, and what approval said.
     */
    async function proposeThenApprove(
      taskId: string,
      options: {
        readonly lineageId?: string;
        readonly purpose: string;
        readonly maximumMinor: number;
      },
    ) {
      const versions = await versionsOn(taskId);
      const pending = await pendingGatesOn(taskId);
      const body = proposeBody(taskId, await revisionOf(s, taskId), options);
      const proposed = await asPerson(s, body);
      const answer = codeOf(proposed);
      const written = (await versionsOn(taskId)) - versions;
      const pendingWritten = (await pendingGatesOn(taskId)) - pending;
      const outcomes = (
        await rows<{ outcome: string }>(
          s,
          `select outcome from public.audit_events
            where business_id = $1 and operation_id = $2 order by outcome`,
          [s.business, body['operationId']],
        )
      ).map((each) => each.outcome);
      const approval = isCommandRefusal(proposed)
        ? null
        : codeOf(await asPerson(s, approveBody(proposed.detail as Detail)));
      return { answer, written, pendingWritten, outcomes, approval };
    }

    it('a successor past the envelope, within the cap, is refused with nothing written', async () => {
      const taskId = await createTask(s, 'an approved lineage whose envelope holds 4,000');
      const purpose = freshPurpose();
      const first = await propose(s, taskId, { purpose, maximumMinor: ENVELOPE });
      await approve(s, first);
      expect(await envelopeMaximum(taskId)).toBe(String(ENVELOPE));

      // One unit past the envelope and far inside the cap: the cap check alone
      // admits it, and `budgetRoom` refuses its approval BUDGET_UNAVAILABLE.
      expect(
        await proposeThenApprove(taskId, {
          lineageId: String(first['lineageId']),
          purpose,
          maximumMinor: ENVELOPE + 1,
        }),
      ).toStrictEqual({
        answer: 'PROPOSAL_OUT_OF_SCOPE',
        written: 0,
        pendingWritten: 0,
        outcomes: ['refused'],
        approval: null,
      });
    }, 60_000);

    it('control: a successor at the room its predecessor gives back applies and approves', async () => {
      const taskId = await createTask(s, 'an approved lineage, succeeded within its envelope');
      const purpose = freshPurpose();
      const first = await propose(s, taskId, { purpose, maximumMinor: ENVELOPE });
      await approve(s, first);

      expect(
        await proposeThenApprove(taskId, {
          lineageId: String(first['lineageId']),
          purpose,
          maximumMinor: ENVELOPE,
        }),
      ).toStrictEqual({
        answer: 'applied',
        written: 1,
        pendingWritten: 1,
        outcomes: ['applied'],
        approval: 'applied',
      });
    }, 60_000);

    it('a new lineage on a task whose envelope is full is refused, not left pending', async () => {
      const taskId = await createTask(s, 'a full envelope and a second line of work');
      const first = await propose(s, taskId, {
        purpose: freshPurpose(),
        maximumMinor: ENVELOPE,
      });
      await approve(s, first);

      expect(
        await proposeThenApprove(taskId, { purpose: freshPurpose(), maximumMinor: 1 }),
      ).toStrictEqual({
        answer: 'PROPOSAL_OUT_OF_SCOPE',
        written: 0,
        pendingWritten: 0,
        outcomes: ['refused'],
        approval: null,
      });
    }, 60_000);

    it('control: with no envelope open, the cap alone bounds the proposal', async () => {
      const taskId = await createTask(s, 'no envelope yet');
      expect(
        await proposeThenApprove(taskId, { purpose: freshPurpose(), maximumMinor: ENVELOPE * 2 }),
      ).toMatchObject({ answer: 'applied', written: 1, pendingWritten: 1, approval: 'applied' });
    }, 60_000);
  },
);

describe.skipIf(serverUrl === undefined)(
  'R3-AUTHORITY-19 and R3-AUTHORITY-20: the lineage first',
  () => {
    let s: Schedules;
    const LIMIT = 100_000;

    beforeAll(async () => {
      s = await openSchedules('fr3_propose_lineage', LIMIT);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    /** The answer's code, names and fixes, or the fault the entry threw. */
    async function answered(body: Readonly<Record<string, unknown>>): Promise<unknown> {
      try {
        const result = await asPerson(s, body);
        return isCommandRefusal(result)
          ? { code: result.code, names: result.names, fixes: result.fixes }
          : 'applied';
      } catch (cause) {
        return `fault ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    }

    it("R3-AUTHORITY-20: another task's lineage is LINEAGE_NOT_ON_TASK whatever the ceiling", async () => {
      const own = await createTask(s, 'the task the caller proposes on');
      const other = await createTask(s, 'a sibling task whose approved version holds 30,000');
      const held = await propose(s, other, { purpose: freshPurpose(), maximumMinor: 30_000 });
      await approve(s, held);
      // A third task's hold, so the cap has 50,000 committed and a ceiling of
      // the whole limit is past its room even less the sibling's 30,000.
      const filler = await createTask(s, 'a third task holding 20,000 of the cap');
      await approve(s, await propose(s, filler, { purpose: freshPurpose(), maximumMinor: 20_000 }));
      const lineageId = String(held['lineageId']);

      const at = async (maximumMinor: number) =>
        await answered(
          proposeBody(own, await revisionOf(s, own), {
            purpose: freshPurpose(),
            lineageId,
            maximumMinor,
          }),
        );
      const past = await at(LIMIT);
      const within = await at(1);

      expect(past).toMatchObject({ code: 'LINEAGE_NOT_ON_TASK' });
      expect(past).toStrictEqual(within);
      expect(JSON.stringify(past)).not.toMatch(/committed|20000|30000|50000/u);
    }, 60_000);

    it('R3-AUTHORITY-19: an upper-case lineageId continues the lineage like the lower-case one', async () => {
      const taskId = await createTask(s, 'a lineage named in upper case');
      const purpose = freshPurpose();
      const first = await propose(s, taskId, { purpose });
      const lineageId = String(first['lineageId']);

      expect(
        await answered(
          proposeBody(taskId, await revisionOf(s, taskId), {
            purpose,
            lineageId: lineageId.toUpperCase(),
          }),
        ),
      ).toBe('applied');
      const versions = await rows<{ version: string; superseded: boolean }>(
        s,
        `select version::text as version, superseded_at is not null as superseded
         from public.proposal_versions where business_id = $1 and lineage_id = $2
        order by version`,
        [s.business, lineageId],
      );
      expect(versions.map(({ version, superseded }) => ({ version, superseded }))).toStrictEqual([
        { version: '1', superseded: true },
        { version: '2', superseded: false },
      ]);
    }, 60_000);
  },
);

describe.skipIf(serverUrl === undefined)(
  'R2-RUNTIME-26 residual (b): task.restart checks the cap',
  () => {
    let s: Schedules;
    const LIMIT = 1_000;

    beforeAll(async () => {
      s = await openSchedules('fr3_propose_restart', LIMIT);
    }, 90_000);

    afterAll(async () => {
      await s?.db.drop();
    });

    it('a restart past the business cap room is refused with nothing written', async () => {
      const taskId = await createTask(s, 'a rejected lineage restarted after the cap filled');
      const rejected = await propose(s, taskId, { purpose: freshPurpose(), maximumMinor: LIMIT });
      expect(codeOf(await asPerson(s, { ...approveBody(rejected), decision: 'reject' }))).toBe(
        'applied',
      );
      const other = await createTask(s, 'a second task approved at 500');
      await approve(s, await propose(s, other, { purpose: freshPurpose(), maximumMinor: 500 }));

      const counted = async (table: 'proposal_versions' | 'gates') =>
        await scalar(
          s,
          `select count(*)::text as n from public.${table} t
           join public.proposal_lineages lin
             on lin.business_id = t.business_id and lin.id = t.lineage_id
          where t.business_id = $1 and lin.task_id = $2
            ${table === 'gates' ? "and t.state = 'pending'" : ''}`,
          [s.business, taskId],
        );
      const versions = await counted('proposal_versions');
      const pending = await counted('gates');
      const restarted = await asPerson(s, {
        command: 'task.restart',
        operationId: randomUUID(),
        recordId: taskId,
        lineageId: rejected['lineageId'],
      });
      const approval = isCommandRefusal(restarted)
        ? null
        : codeOf(await asPerson(s, approveBody(restarted.detail as Detail)));

      expect({
        answer: codeOf(restarted),
        written: (await counted('proposal_versions')) - versions,
        pendingWritten: (await counted('gates')) - pending,
        approval,
      }).toStrictEqual({
        answer: 'PROPOSAL_OUT_OF_SCOPE',
        written: 0,
        pendingWritten: 0,
        approval: null,
      });
    }, 60_000);
  },
);
