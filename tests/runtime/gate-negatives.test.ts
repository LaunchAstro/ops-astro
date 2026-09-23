// SPDX-License-Identifier: AGPL-3.0-only
//
// The gate negatives the L6 packet found missing at 74d583c (section 8):
//
//   G01  a gate carrying a null, foreign-business or mismatched run, step or
//        evidence reference is refused, by the schema or before a decision;
//   G03  two concurrent `task.decide` calls through the envelope, on two
//        connections, give one decision and one durable refused attempt;
//   G07  a decide against a pack that is empty, missing, mismatched or
//        rendered for a superseded version is refused and writes nothing;
//   G08  comments are not rounds: they leave the round count where it was, the
//        third request for changes is still refused, and the two recorded
//        rounds are still there afterwards.
//
// The positives and the sequential forms of these live in `gate.test.ts`,
// `tests/commands/task-runtime.test.ts` and `unproduced-reach.test.ts`; the
// cases here are only the ones those files do not execute. Replay is not a
// race and is not tested here: an identical repeat is the envelope's replay,
// a different second decision is a refusal, and they are kept apart.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createFreshDatabase,
  databaseUrlFromEnvironment,
  type FreshDatabase,
} from '../../packages/core-records/src/tenancy/testing/fresh-database.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import { isCommandRefusal } from '../../packages/core-records/src/commands/refusal.ts';
import {
  awaitWaiters,
  barrier,
  buildGateWorld,
  expectRefusedWithoutEffect,
  sqlRefusal,
  type GateWorld,
  type Proposal,
} from './gate-negatives-cases.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/gate-negatives: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

describe.skipIf(serverUrl === undefined)('gate negatives', () => {
  let db: FreshDatabase;
  let world: GateWorld;
  let foreign: GateWorld;

  beforeAll(async () => {
    process.env['GATE_SIGNING_KEY_ID'] = 'test/gate-negatives@1';
    process.env['GATE_SIGNING_SECRET'] = randomUUID();
    db = await createFreshDatabase({ part: 'gateneg' });
    world = await buildGateWorld(db, 'gate-negatives');
    foreign = await buildGateWorld(db, 'gate-negatives-foreign');
  }, 90_000);

  afterAll(async () => {
    await db?.drop();
  });

  async function freshProposal(title: string): Promise<Proposal> {
    return await world.propose(await world.createTask(title));
  }

  /** An update as the application role, inside the business, the way a handler would write. */
  async function updateGateAsApp(gateId: string, column: string, value: string | null) {
    return await sqlRefusal(
      db.app.withBusiness(
        world.business,
        async (tx) =>
          await tx.query(
            `update public.gates set ${column} = $3 where business_id = $1 and id = $2`,
            [world.business, gateId, value],
          ),
      ),
    );
  }

  async function gateRow(gateId: string) {
    const rows = await db.admin.execute<Record<string, unknown>>(
      `select * from public.gates where id = $1`,
      [gateId],
    );
    return rows[0];
  }

  describe('G01: the gate references a real run, step and pack of its own business and version', () => {
    it.each([
      ['run_id', 'gates_run_fkey', (p: Proposal) => p.runId],
      ['step_id', 'gates_step_fkey', (p: Proposal) => p.stepId],
      ['evidence_pack_id', 'gates_evidence_fkey', (p: Proposal) => p.evidencePackId],
    ] as const)(
      'refuses a null and a foreign-business %s on a gate, and leaves the gate as written',
      async (column, constraint, of) => {
        const proposal = await freshProposal(`G01 ${column}`);
        const elsewhere = await foreign.propose(await foreign.createTask(`G01 foreign ${column}`));
        const written = await gateRow(proposal.gateId);

        expect(await updateGateAsApp(proposal.gateId, column, null)).toStrictEqual({
          code: '23502',
          constraint: null,
          column,
        });
        // A real row, in another business. The composite key, not row security,
        // is what refuses it: the foreign key check does not read through RLS.
        expect(await updateGateAsApp(proposal.gateId, column, of(elsewhere))).toStrictEqual({
          code: '23503',
          constraint,
          column: null,
        });

        expect(await gateRow(proposal.gateId)).toStrictEqual(written);
      },
    );

    it('refuses to decide a gate whose run and step belong to another version of the same business', async () => {
      // The foreign keys are (business_id, run_id) and (business_id, step_id),
      // so a same-business run of another proposal satisfies them. This is the
      // "mismatched" reference; the hand-made gate is the "fake fixture gate".
      const proposal = await freshProposal('G01 mismatched run');
      const other = await freshProposal('G01 the run it is swapped with');

      const tamper = await sqlRefusal(
        db.admin.execute(
          `update public.gates set run_id = $2, step_id = $3 where business_id = $1 and id = $4`,
          [world.business, other.runId, other.stepId, proposal.gateId],
        ),
      );
      if (tamper.code !== 'accepted') {
        // The schema refused the mismatch itself, which is the stronger answer.
        expect(tamper.code).toMatch(/^23/u);
        return;
      }

      const before = await world.snapshot(proposal.gateId);
      const operationId = randomUUID();
      const outcome = await world.call(world.decideBody(proposal, 'approve', operationId));
      expect(
        isCommandRefusal(outcome) ? outcome.code : outcome.detail,
        "a gate bound to another version's run and step was decided",
      ).toEqual(expect.any(String));
      const code = isCommandRefusal(outcome) ? outcome.code : 'applied';
      await expectRefusedWithoutEffect(world, outcome, code, operationId, before, proposal.gateId);
    });
  });

  describe('G07: a decide against evidence that is not this version’s rendered pack is refused', () => {
    it('refuses an empty pack and a missing pack at the schema', async () => {
      const proposal = await freshProposal('G07 empty');
      const packs = async () =>
        await db.admin.execute(`select * from public.evidence_packs where id = $1`, [
          proposal.evidencePackId,
        ]);
      const pack = await packs();

      for (const empty of ['{}', '[]', 'null']) {
        // eslint-disable-next-line no-await-in-loop
        const refusal = await sqlRefusal(
          db.admin.execute(`update public.evidence_packs set rendered = $2::jsonb where id = $1`, [
            proposal.evidencePackId,
            empty,
          ]),
        );
        expect(refusal).toStrictEqual({
          code: '23514',
          constraint: 'evidence_packs_not_empty',
          column: null,
        });
      }
      // Not rendered: a gate with no pack, and a pack removed from under its gate.
      expect((await updateGateAsApp(proposal.gateId, 'evidence_pack_id', null)).code).toBe('23502');
      expect(
        await sqlRefusal(
          db.admin.execute(`delete from public.evidence_packs where id = $1`, [
            proposal.evidencePackId,
          ]),
        ),
      ).toMatchObject({ code: '23503', constraint: 'gates_evidence_fkey' });

      expect(await packs()).toStrictEqual(pack);
    });

    const TAMPERS: readonly (readonly [
      string,
      (world: GateWorld, proposal: Proposal) => Promise<Proposal>,
    ])[] = [
      [
        'a gate digest that disagrees with its version',
        async (w, proposal) => {
          await w.db.admin.execute(`update public.gates set payload_digest = $2 where id = $1`, [
            proposal.gateId,
            'f'.repeat(64),
          ]);
          return proposal;
        },
      ],
      [
        'a pack rendered against other content',
        async (w, proposal) => {
          await w.db.admin.execute(
            `update public.evidence_packs set version_digest = $2 where id = $1`,
            [proposal.evidencePackId, '0'.repeat(64)],
          );
          return proposal;
        },
      ],
      [
        'a pack rendered for another proposal',
        async (w, proposal) => {
          const other = await w.propose(await w.createTask('G07 the other proposal'));
          await w.db.admin.execute(`update public.gates set evidence_pack_id = $2 where id = $1`, [
            proposal.gateId,
            other.evidencePackId,
          ]);
          return proposal;
        },
      ],
      [
        'a stale pack, rendered for the version this one superseded',
        async (w, proposal) => {
          await w.call(w.decideBody(proposal, 'request_changes'));
          const successor = await w.propose(
            (
              await w.db.admin.execute<{ readonly task_id: string }>(
                `select task_id from public.planned_runs where id = $1`,
                [proposal.runId],
              )
            )[0]?.task_id as string,
            proposal.lineageId,
          );
          await w.db.admin.execute(`update public.gates set evidence_pack_id = $2 where id = $1`, [
            successor.gateId,
            proposal.evidencePackId,
          ]);
          return successor;
        },
      ],
    ];

    it.each(TAMPERS)(
      'refuses EVIDENCE_MISMATCH on %s, with no decision, hold or attempt',
      async (label, tamper) => {
        const decided = await tamper(world, await freshProposal(`G07 ${label}`));
        const before = await world.snapshot(decided.gateId);
        const operationId = randomUUID();
        const outcome = await world.call(world.decideBody(decided, 'approve', operationId));
        await expectRefusedWithoutEffect(
          world,
          outcome,
          'EVIDENCE_MISMATCH',
          operationId,
          before,
          decided.gateId,
        );
        expect(before.gate.state).toBe('pending');
      },
    );
  });

  describe('G03: two concurrent decisions through the envelope', () => {
    it('gives one decision and the loser one durable GATE_ALREADY_DECIDED refusal', async () => {
      const proposal = await freshProposal('G03 two deciders at once');
      const before = await world.snapshot(proposal.gateId);

      // Three physical connections: the fixture's pool is `max: 1`, and two
      // callers on one pool queue on the pool rather than on the gate. The
      // holder takes the gate row first so that both deciders are *observed*
      // parked on the server before either can finish.
      const holder = connect(db.appUrl, { max: 1, source: 'g03-holder' });
      const left = connect(db.appUrl, { max: 1, source: 'g03-left' });
      const right = connect(db.appUrl, { max: 1, source: 'g03-right' });
      const hold = barrier();
      const locked = barrier();
      const holding = holder.withBusiness(world.business, async (tx) => {
        await tx.query(`select 1 from public.gates where business_id = $1 and id = $2 for update`, [
          world.business,
          proposal.gateId,
        ]);
        locked.release();
        await hold.held;
      });
      await locked.held;

      const leftId = randomUUID();
      const rightId = randomUUID();
      const racing = Promise.all([
        world.call(world.decideBody(proposal, 'approve', leftId), left),
        world.call(world.decideBody(proposal, 'reject', rightId), right),
      ]);
      try {
        await awaitWaiters(db, 2);
      } finally {
        hold.release();
      }
      await holding;
      const outcomes = await racing;
      await Promise.all([holder.close(), left.close(), right.close()]);

      const refused = outcomes.filter((outcome) => isCommandRefusal(outcome));
      const applied = outcomes.filter((outcome) => !isCommandRefusal(outcome));
      expect(applied).toHaveLength(1);
      expect(
        refused.map((outcome) => (isCommandRefusal(outcome) ? outcome.code : '')),
      ).toStrictEqual(['GATE_ALREADY_DECIDED']);

      const loserId = isCommandRefusal(outcomes[0]) ? leftId : rightId;
      const winnerId = loserId === leftId ? rightId : leftId;
      expect((await world.auditFor(loserId)).map((e) => [e.outcome, e.refusal_code])).toStrictEqual(
        [['refused', 'GATE_ALREADY_DECIDED']],
      );
      expect((await world.auditFor(winnerId)).map((e) => e.outcome)).toStrictEqual(['applied']);

      const after = await world.snapshot(proposal.gateId);
      expect(after.counts['gate_decisions']).toBe((before.counts['gate_decisions'] ?? 0) + 1);
      const decisions = await db.admin.execute<{ readonly decision: string }>(
        `select decision from public.gate_decisions where gate_id = $1`,
        [proposal.gateId],
      );
      expect(decisions).toHaveLength(1);
      expect(after.gate.state).toBe(decisions[0]?.decision === 'approve' ? 'approved' : 'rejected');
    }, 60_000);
  });

  describe('G08: comments are not rounds', () => {
    it('leaves the round count, the recorded rounds and the third-round refusal where they were', async () => {
      const task = await world.createTask('G08 comments between rounds');
      const v1 = await world.propose(task);

      async function commentsChangeNothing(gateId: string): Promise<void> {
        const before = await world.snapshot(gateId);
        for (const note of ['please tighten it', 'and shorter', 'thanks']) {
          // eslint-disable-next-line no-await-in-loop
          await world.comment(task, note);
        }
        expect(await world.snapshot(gateId)).toStrictEqual(before);
      }

      await commentsChangeNothing(v1.gateId);
      expect(isCommandRefusal(await world.call(world.decideBody(v1, 'request_changes')))).toBe(
        false,
      );

      const v2 = await world.propose(task, v1.lineageId);
      await commentsChangeNothing(v2.gateId);
      // Round two is still available after three comments on each version.
      expect((await world.snapshot(v2.gateId)).gate.round).toBe(2);
      expect(isCommandRefusal(await world.call(world.decideBody(v2, 'request_changes')))).toBe(
        false,
      );

      const v3 = await world.propose(task, v2.lineageId);
      await commentsChangeNothing(v3.gateId);
      expect((await world.snapshot(v3.gateId)).gate.round).toBe(3);

      const before = await world.snapshot(v3.gateId);
      const operationId = randomUUID();
      const third = await world.call(world.decideBody(v3, 'request_changes', operationId));
      await expectRefusedWithoutEffect(
        world,
        third,
        'CHANGE_ROUNDS_EXHAUSTED',
        operationId,
        before,
        v3.gateId,
      );

      // The two rounds are still on the lineage: nothing erased them.
      const rounds = await db.admin.execute<{ readonly decision: string; readonly round: number }>(
        `select decision, round from public.gate_decisions where lineage_id = $1 order by seq`,
        [v1.lineageId],
      );
      expect(rounds).toEqual([
        { decision: 'request_changes', round: 1 },
        { decision: 'request_changes', round: 2 },
      ]);
    });
  });
});
