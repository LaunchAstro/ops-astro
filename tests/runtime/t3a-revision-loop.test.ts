// SPDX-License-Identifier: AGPL-3.0-only
//
// T3a, the revision loop over settled work, over a real database through the
// command entry.
//
// `revision_loop_keeps_settled` (split 2.2, D4 and D5): after one settled
// attempt, two request-changes rounds, the refused third, a rejection and a
// restart leave the settled amount unchanged and non-zero; the rejected
// version is never approved again; the restart opens a new lineage and, on
// approval, a new envelope, so the old envelope funds nothing new. Red until
// T2d settles real spend: before it, "settled and non-zero" has nothing to
// hold.
//
// Beside it: the terminal-lineage trigger (0040) refuses any write to a
// terminal lineage, whoever makes it; `T3 decide authority` refuses approve,
// reject, restart and cancel to a person without `decide` on each surface and
// to an agent, and writes nothing; another business's gate and lineage are not
// found, and a person whose decide grant is on another task is refused.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import type { EntryPoint } from '../../packages/core-records/src/tasks/placement.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { insertBusiness } from '../identity/fixture.ts';
import {
  appliedDetail,
  asAgent,
  asPerson,
  codeOf,
  openSchedules,
  propose,
  proposeBody,
  revisionOf,
  rows,
  type Body,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { cq8World, PRICED, t2dHarness } from './t2d-harness.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t3a-revision-loop: DATABASE_URL is unset, so nothing below ran.');
}

const SURFACES: readonly EntryPoint[] = ['app', 'api', 'cli'];

/** A revision's ceiling: inside what the settled envelope has left (2500 held, 1800 spent). */
const REVISION = 500;

const decideBody = (version: Detail, decision: string): Body => ({
  command: 'task.decide',
  operationId: randomUUID(),
  gateId: version['gateId'],
  versionId: version['versionId'],
  decision,
  note: `${decision} in the T3a loop`,
});

const restartBody = (taskId: string, lineageId: unknown): Body => ({
  command: 'task.restart',
  operationId: randomUUID(),
  recordId: taskId,
  lineageId,
});

const cancelBody = (taskId: string, lineageId: unknown): Body => ({
  command: 'task.cancel',
  operationId: randomUUID(),
  recordId: taskId,
  lineageId,
  reason: 'stopped in the T3a loop',
});

describe.skipIf(serverUrl === undefined)('T3a the revision loop over settled work', () => {
  let s: Schedules;
  const { work, applied, observeOf } = t2dHarness(() => s);

  beforeAll(async () => {
    s = await openSchedules('t3a', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  async function envelopes(taskId: string) {
    return await rows<{
      readonly id: string;
      readonly state: string;
      readonly held: string;
      readonly actual: string;
    }>(
      s,
      `select id, state, held_minor::text as held, actual_minor::text as actual
         from public.task_envelopes where business_id = $1 and task_id = $2
        order by opened_at, id`,
      [s.business, taskId],
    );
  }

  /** One approved, picked-up, applied and settled attempt: 1800 spent of 2500 held. */
  async function settledWork() {
    const w = await work();
    await applied(w);
    appliedDetail(await observeOf(w, { usage: PRICED }), 'task.observe');
    const [envelope] = await envelopes(w.taskId);
    expect(envelope).toMatchObject({ state: 'open', held: '0', actual: '1800' });
    return { w, envelopeId: String(envelope?.id), lineageId: String(w.proposal['lineageId']) };
  }

  it('revision_loop_keeps_settled: two rounds, the third refused, reject terminal, restart on a new envelope, settled spend unmoved', async () => {
    const { w, envelopeId, lineageId } = await settledWork();
    const settled = async () =>
      (
        await rows<{ readonly actual: string }>(
          s,
          `select actual_minor::text as actual from public.task_envelopes
            where business_id = $1 and id = $2`,
          [s.business, envelopeId],
        )
      )[0]?.actual;

    // Two formal rounds of changes on the settled work, then the third refused.
    const v2 = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    expect(codeOf(await asPerson(s, decideBody(v2, 'request_changes')))).toBe('applied');
    const v3 = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    expect(codeOf(await asPerson(s, decideBody(v3, 'request_changes')))).toBe('applied');
    const v4 = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
    expect(codeOf(await asPerson(s, decideBody(v4, 'request_changes')))).toBe(
      'CHANGE_ROUNDS_EXHAUSTED',
    );
    expect(await settled()).toBe('1800');

    // Reject: terminal, and the rejected version is never approved again.
    expect(codeOf(await asPerson(s, decideBody(v4, 'reject')))).toBe('applied');
    expect(codeOf(await asPerson(s, decideBody(v4, 'approve')))).not.toBe('applied');
    expect(
      codeOf(
        await asPerson(
          s,
          proposeBody(w.taskId, await revisionOf(s, w.taskId), {
            lineageId,
            maximumMinor: REVISION,
          }),
        ),
      ),
    ).toBe('LINEAGE_TERMINAL');
    expect(await settled()).toBe('1800');

    // Restart: a new lineage, and its approval opens a new envelope.
    const restarted = appliedDetail(
      await asPerson(s, restartBody(w.taskId, lineageId)),
      'task.restart',
    );
    expect(restarted['lineageId']).not.toBe(lineageId);
    expect(restarted['restartsLineageId']).toBe(lineageId);
    const approved = appliedDetail(await asPerson(s, decideBody(restarted, 'approve')), 'approve');
    expect(approved['envelopeId']).not.toBe(envelopeId);

    const after = await envelopes(w.taskId);
    expect(after).toHaveLength(2);
    expect(after.find((one) => one.id === envelopeId)).toMatchObject({
      state: 'closed',
      held: '0',
      actual: '1800',
    });
    expect(after.find((one) => one.id === approved['envelopeId'])).toMatchObject({
      state: 'open',
      held: String(REVISION),
      actual: '0',
    });
    // The settled attempt itself is untouched.
    const attempt = await rows<{ readonly state: string; readonly actual: string }>(
      s,
      `select state, actual_minor::text as actual from public.attempts
        where business_id = $1 and id = $2`,
      [s.business, w.attemptId],
    );
    expect(attempt).toEqual([{ state: 'settled', actual: '1800' }]);
  });

  it('a restart replayed by its operation identifier opens one lineage and closes one envelope', async () => {
    const { w, lineageId } = await settledWork();
    expect(codeOf(await asPerson(s, cancelBody(w.taskId, lineageId)))).toBe('applied');
    const body = restartBody(w.taskId, lineageId);
    const first = appliedDetail(await asPerson(s, body), 'task.restart');
    const again = appliedDetail(await asPerson(s, body), 'task.restart replayed');
    expect(again['lineageId']).toBe(first['lineageId']);
    const lineages = await rows<{ readonly n: number }>(
      s,
      `select count(*)::int as n from public.proposal_lineages
        where business_id = $1 and restarts_lineage_id = $2`,
      [s.business, lineageId],
    );
    expect(lineages[0]?.n).toBe(1);
    expect((await envelopes(w.taskId)).map((one) => one.state)).toStrictEqual(['closed']);
  });

  it('a terminal lineage is enforced by the database: no role reopens or rewrites it', async () => {
    const { w, lineageId } = await settledWork();
    expect(codeOf(await asPerson(s, cancelBody(w.taskId, lineageId)))).toBe('applied');
    for (const statement of [
      `update public.proposal_lineages set state = 'live', terminal_reason = null, terminal_at = null
        where business_id = $1 and id = $2`,
      `update public.proposal_lineages set state = 'rejected', terminal_reason = 'gate_rejected'
        where business_id = $1 and id = $2`,
      `update public.proposal_lineages set terminal_at = now() where business_id = $1 and id = $2`,
    ]) {
      // Sequential: each statement is its own attempt against the same row.
      // eslint-disable-next-line no-await-in-loop
      await expect(s.db.admin.execute(statement, [s.business, lineageId])).rejects.toThrow(
        /LINEAGE_TERMINAL/u,
      );
    }
    const [row] = await rows<{ readonly state: string }>(
      s,
      `select state from public.proposal_lineages where business_id = $1 and id = $2`,
      [s.business, lineageId],
    );
    expect(row?.state).toBe('cancelled');
  });

  describe('T3 decide authority', () => {
    /** Everything a decision, a restart or a cancel could write. */
    async function footprint(taskId: string) {
      return await rows<Record<string, unknown>>(
        s,
        `select (select count(*)::int from public.gate_decisions d where d.business_id = $1) as decisions,
                (select count(*)::int from public.proposal_lineages l
                  where l.business_id = $1 and l.task_id = $2) as lineages,
                (select string_agg(l.state, ',' order by l.id) from public.proposal_lineages l
                  where l.business_id = $1 and l.task_id = $2) as lineage_states,
                (select string_agg(e.state || ':' || e.held_minor || ':' || e.actual_minor, ',' order by e.id)
                   from public.task_envelopes e where e.business_id = $1 and e.task_id = $2) as envelopes,
                (select string_agg(g.state, ',' order by g.id) from public.gates g
                   join public.proposal_lineages l on l.business_id = g.business_id and l.id = g.lineage_id
                  where g.business_id = $1 and l.task_id = $2) as gates`,
        [s.business, taskId],
      );
    }

    async function writer(scope?: { readonly kind: 'record'; readonly id: string }) {
      const member = await enrol(s.db.app, s.business, `writer-${randomUUID()}`);
      await s.db.app.withBusiness(s.business, async (tx) => {
        for (const action of ['read', 'write', 'comment'] as const) {
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, member, action);
        }
        if (scope !== undefined) await grantTo(tx, member, 'decide', scope);
      });
      return member;
    }

    const as = async (member: Member, surface: EntryPoint, body: Body) =>
      await executeCommand(s.db.app, s.business, member.presented, surface, body as never);

    it('approve, reject, restart and cancel are refused to a person without decide, on the app, the API and the command line, and write nothing', async () => {
      const { w, lineageId } = await settledWork();
      const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
      const noDecide = await writer();
      const before = await footprint(w.taskId);
      for (const surface of SURFACES) {
        for (const body of [
          decideBody(pending, 'approve'),
          decideBody(pending, 'reject'),
          decideBody(pending, 'request_changes'),
          cancelBody(w.taskId, lineageId),
        ]) {
          // eslint-disable-next-line no-await-in-loop
          const code = codeOf(await as(noDecide, surface, body));
          expect({ surface, command: body['command'], decision: body['decision'], code }).toEqual({
            surface,
            command: body['command'],
            decision: body['decision'],
            code: 'SCOPE_NOT_GRANTED',
          });
        }
      }
      expect(await footprint(w.taskId)).toStrictEqual(before);

      // Restart needs a terminal lineage: the decider rejects, the writer tries.
      expect(codeOf(await asPerson(s, decideBody(pending, 'reject')))).toBe('applied');
      const rejected = await footprint(w.taskId);
      for (const surface of SURFACES) {
        // eslint-disable-next-line no-await-in-loop
        const code = codeOf(await as(noDecide, surface, restartBody(w.taskId, lineageId)));
        expect({ surface, code }).toEqual({ surface, code: 'SCOPE_NOT_GRANTED' });
      }
      expect(await footprint(w.taskId)).toStrictEqual(rejected);
    });

    it('each is refused to an agent under its live delegation, and writes nothing', async () => {
      const { w, lineageId } = await settledWork();
      const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
      const before = await footprint(w.taskId);
      for (const body of [
        decideBody(pending, 'approve'),
        decideBody(pending, 'reject'),
        decideBody(pending, 'request_changes'),
        cancelBody(w.taskId, lineageId),
        restartBody(w.taskId, lineageId),
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const code = codeOf(await asAgent(s, body, w.credential));
        expect({ command: body['command'], code }).not.toMatchObject({ code: 'applied' });
      }
      expect(await footprint(w.taskId)).toStrictEqual(before);
    });

    it('a person whose decide grant is on another task is refused here, and writes nothing', async () => {
      const { w, lineageId } = await settledWork();
      const other = await work();
      const elsewhere = await writer({ kind: 'record', id: other.taskId });
      const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
      const before = await footprint(w.taskId);
      for (const body of [
        decideBody(pending, 'approve'),
        decideBody(pending, 'reject'),
        cancelBody(w.taskId, lineageId),
      ]) {
        // eslint-disable-next-line no-await-in-loop
        expect(codeOf(await as(elsewhere, 'api', body))).toBe('SCOPE_NOT_GRANTED');
      }
      expect(await footprint(w.taskId)).toStrictEqual(before);
    });

    it("a client shared on this task, and another task's client, are each refused, and nothing moves", async () => {
      const { w, lineageId } = await settledWork();
      const other = await work();
      const world = cq8World(s);
      await s.db.app.withBusiness(s.business, async (tx) => {
        await grantTo(tx, s.decider, 'share');
      });
      const own = await world.client(s.business, s.decider, 't3a-own-client', w.taskId);
      const foreign = await world.client(s.business, s.decider, 't3a-other-client', other.taskId);
      const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
      const before = await footprint(w.taskId);
      for (const who of [own, foreign]) {
        for (const body of [
          decideBody(pending, 'approve'),
          decideBody(pending, 'reject'),
          cancelBody(w.taskId, lineageId),
          restartBody(w.taskId, lineageId),
        ]) {
          // eslint-disable-next-line no-await-in-loop
          const result = await as(who, 'api', body);
          expect(codeOf(result)).not.toBe('applied');
          if (who === foreign) expect(JSON.stringify(result)).not.toContain(w.taskId);
        }
      }
      expect(await footprint(w.taskId)).toStrictEqual(before);
    });

    it("another business's gate and lineage are not found, and nothing moves", async () => {
      const { w, lineageId } = await settledWork();
      const pending = await propose(s, w.taskId, { lineageId, maximumMinor: REVISION });
      const foreign = await insertBusiness(s.db.app, `t3a-foreign-${randomUUID()}`);
      await installSpine(s.db.app, foreign);
      const stranger = await enrol(s.db.app, foreign, 'stranger');
      await s.db.app.withBusiness(foreign, async (tx) => {
        for (const action of ['read', 'write', 'decide'] as const) {
          // eslint-disable-next-line no-await-in-loop
          await grantTo(tx, stranger, action);
        }
        // A cap of its own, so the decision reaches the gate lookup.
        await tx.query(
          `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
           values ($1, $2, 'local', 100000, 'AUD')`,
          [foreign, randomUUID()],
        );
      });
      const before = await footprint(w.taskId);
      for (const body of [
        decideBody(pending, 'approve'),
        decideBody(pending, 'reject'),
        cancelBody(w.taskId, lineageId),
        restartBody(w.taskId, lineageId),
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const result = await executeCommand(
          s.db.app,
          foreign as never,
          stranger.presented,
          'api',
          body as never,
        );
        expect(codeOf(result)).toBe('NOT_FOUND');
        expect(JSON.stringify(result)).not.toContain(String(pending['gateId']));
        expect(JSON.stringify(result)).not.toContain(lineageId);
      }
      expect(await footprint(w.taskId)).toStrictEqual(before);
    });
  });
});
