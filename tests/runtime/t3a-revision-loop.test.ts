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
// terminal lineage, whoever makes it. The decide-authority cases are in
// `t3a-decide-authority.test.ts`, and what both share in `t3a-support.ts`.

import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  appliedDetail,
  asPerson,
  codeOf,
  createTask,
  openSchedules,
  propose,
  proposeBody,
  revisionOf,
  rows,
  type Schedules,
} from './schedules-harness.ts';

import { cancelBody, decideBody, noop, restartBody, REVISION, t3aHarness } from './t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn('runtime/t3a-revision-loop: DATABASE_URL is unset, so nothing below ran.');
}

describe.skipIf(serverUrl === undefined)('T3a the revision loop over settled work', () => {
  let s: Schedules;
  const { envelopes, settledWork } = t3aHarness(() => s);

  beforeAll(async () => {
    s = await openSchedules('t3a', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

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

  it('a version insert cannot cross a concurrent terminal transition', async () => {
    const taskId = await createTask(s, `terminal race ${randomUUID()}`);
    const first = await propose(s, taskId);
    const lineageId = String(first['lineageId']);
    const newVersionId = randomUUID();
    const lockKey = 73003036;
    const ownerUrl = new URL(String(serverUrl));
    ownerUrl.pathname = `/${s.db.name}`;
    const owner = postgres(ownerUrl.toString(), { max: 2 });
    await s.db.admin.execute(
      `create function public.sol_pause_after_lineage_check() returns trigger language plpgsql as $$
       begin
         perform pg_advisory_xact_lock(${lockKey});
         return new;
       end $$`,
    );
    await s.db.admin.execute(
      `create trigger zz_sol_pause_after_lineage_check before insert on public.proposal_versions
       for each row execute function public.sol_pause_after_lineage_check()`,
    );
    let release = noop;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = owner.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${lockKey})`;
      await released;
    });
    let inserted: Promise<readonly unknown[]> | undefined;
    try {
      // Wait for the owner to take the advisory lock before starting the insert.
      for (let tries = 0; tries < 200; tries += 1) {
        // eslint-disable-next-line no-await-in-loop
        const locks = await owner<{ readonly n: string }[]>`
          select count(*)::text as n from pg_locks
           where locktype = 'advisory' and granted and objid = ${lockKey}`;
        if (Number(locks[0]?.n) > 0) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      inserted = s.db.admin.execute(
        `insert into public.proposal_versions
           (business_id, id, lineage_id, version, payload, payload_digest, purpose,
            maximum_minor, currency, proposed_by_actor_id, superseded_at)
         select business_id, $3, lineage_id, version + 1, payload, payload_digest, purpose,
                maximum_minor, currency, proposed_by_actor_id, clock_timestamp()
           from public.proposal_versions where business_id = $1 and lineage_id = $2
           order by version desc limit 1`,
        [s.business, lineageId, newVersionId],
      );
      let waiting = false;
      for (let tries = 0; tries < 200; tries += 1) {
        // eslint-disable-next-line no-await-in-loop
        const locks = await owner<{ readonly n: string }[]>`
          select count(*)::text as n from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
           where a.datname = current_database() and l.locktype = 'advisory' and not l.granted
             and l.objid = ${lockKey}`;
        if (Number(locks[0]?.n) > 0) {
          waiting = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(25);
      }
      expect(waiting).toBe(true);
      expect(codeOf(await asPerson(s, cancelBody(taskId, lineageId)))).toBe('applied');
    } finally {
      release();
      await held;
    }
    try {
      let outcome = 'inserted';
      try {
        await inserted;
      } catch (error) {
        if (!/LINEAGE_TERMINAL/u.test(String(error))) throw error;
        outcome = 'terminal refusal';
      }
      const count = await rows<{ readonly n: number }>(
        s,
        `select count(*)::int as n from public.proposal_versions where business_id = $1 and id = $2`,
        [s.business, newVersionId],
      );
      expect({ outcome, count }).toEqual({ outcome: 'terminal refusal', count: [{ n: 0 }] });
    } finally {
      await s.db.admin.execute(
        `drop trigger zz_sol_pause_after_lineage_check on public.proposal_versions`,
      );
      await s.db.admin.execute(`drop function public.sol_pause_after_lineage_check()`);
      await owner.end();
    }
  }, 60_000);
});
