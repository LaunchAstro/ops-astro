// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- one world, its supersession, every impostor and the control */
//
// #1623 R6 F7: a superseded worker's late report, sent through the real HTTP
// agent door, is kept as evidence and changes nothing. The old holder picks up
// an approved plan and is in its compute phase (dispatch answers
// `LAUNCH_NOT_DECIDED`, R3); a person proposes V2 in the same lineage, which
// supersedes it, approves V2, and the agent picks the replacement up. Only then
// does the old holder send the compute phase's report, the review handback the
// worker shapes (`apps/worker/review.ts`), on its old lease and credential.
//
// The door answers `DELEGATION_NOT_LIVE` and T4's evidence-only intake
// (`agent-late-handback.ts`) keeps one unaccepted `handback_reports` row bound
// to the old attempt's lease, reservation and run. The replacement's lease,
// delegation, reservation, gate and the money are as they were, and the old
// attempt's outcome row is the one the supersession wrote. #1623 adds no door
// change and no new intake for this (design R6, split plan PR A2).
//
// Then each impostor sends the same report: a different agent, the old holder
// at a foreign business's door, the old holder's credential with a foreign
// client's superseded lease, and a person presenting the old lease at the agent
// door and at the person door. Each retains nothing and moves nothing. The
// control is the current holder handing back its own work, which settles.
//
// Every call goes through `createApi` as the server composes it
// (`tests/api/controls-fixture.ts`), never the runtime directly. Outcomes are
// read through `run-outcomes-read.ts` only. The outcome rows are checked softly,
// so the rest of the case still reports: on a tree without R1's supersession
// writer and R2's success writer the red is "no outcome recorded", and every
// other assertion is the intake's behaviour on base.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reviewBody } from '../../apps/worker/review.ts';
import { addClient, grantTo, installSpine } from '../commands/fixture.ts';
import { insertBusiness, insertLogin } from '../identity/fixture.ts';
import {
  agentPath,
  createControls,
  detailOf,
  PROPOSAL,
  type Controls,
} from '../api/controls-fixture.ts';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { attemptOfLease, outcomesOfAttempt, type OutcomeRow } from './run-outcomes-read.ts';

/** The handles one pickup's answer gives the holder. */
interface Held {
  readonly leaseId: string;
  readonly fence: number;
  readonly credential: string;
}

/** A task whose first holder was superseded and whose replacement is picked up. */
interface Superseded {
  readonly taskId: string;
  readonly lineageId: string;
  readonly old: Held;
  readonly replacement: Held;
}

interface Retained {
  readonly lease_id: string;
  readonly reservation_id: string;
  readonly run_id: string;
  readonly fence: string;
  readonly disposition: string;
  readonly outcome: string;
  readonly refusal_code: string | null;
  readonly report: unknown;
}

const heldFrom = (picked: Readonly<Record<string, unknown>>): Held => ({
  leaseId: String(picked['leaseId']),
  fence: Number(picked['fence']),
  credential: String(picked['credential']),
});

/** The compute phase's report, as the worker sends it for review, on `held`'s lease. */
const lateReport = (held: Held): Record<string, unknown> =>
  reviewBody(
    { leaseId: held.leaseId, fence: held.fence },
    randomUUID(),
    PROPOSAL.step,
    PROPOSAL.maximumMinor,
  );

const pairs = (rows: readonly OutcomeRow[]) => rows.map((row) => [row.outcome, row.end_code]);

const noDatabase = databaseUrlFromEnvironment() === undefined;

// eslint-disable-next-line max-lines-per-function -- one world, the late report and its control
describe.skipIf(noDatabase)('a late report from a superseded worker', () => {
  let c: Controls;
  let clientX: string;
  let clientY: string;
  let agentToken: string;
  let strangerToken: string;
  let personToken: string;

  beforeAll(async () => {
    c = await createControls('r2late');
    const { db, business } = c.fixture;
    clientX = randomUUID();
    clientY = randomUUID();
    await addClient(db.app, business, clientX, c.manager);
    await addClient(db.app, business, clientY, c.manager);
    // Linking a task to a client is `task:share`'s (`task.set_party`).
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, c.manager, 'share');
    });
    // Another agent of this business, signed in with a login of its own.
    const strangerSubject = `agent-${randomUUID()}`;
    await db.app.withBusiness(business, async (tx) => {
      const actorId = randomUUID();
      await tx.query(`insert into public.actors (business_id, id, kind) values ($1, $2, 'agent')`, [
        business,
        actorId,
      ]);
      const loginId = await insertLogin(tx, strangerSubject);
      await tx.query(
        `insert into public.actor_logins (business_id, id, login_id, actor_id, linked_by_actor_id)
           values ($1, $2, $3, $4, $5)`,
        [business, randomUUID(), loginId, actorId, c.manager.actorId],
      );
    });
    agentToken = await tokenFor(c.fixture.agent.subject);
    strangerToken = await tokenFor(strangerSubject);
    personToken = await tokenFor(c.manager.presented.subject);
    // A second tenant of the installation, whose door the old holder knocks on.
    const bravo = await insertBusiness(db.app, 'bravo');
    await installSpine(db.app, bravo);
  }, 180_000);

  afterAll(async () => {
    await c?.drop();
  });

  /**
   * On `client`'s task: a plan approved and picked up, its holder in the
   * compute phase, then V2 proposed in the lineage, approved and picked up.
   */
  async function superseded(client: string, title: string): Promise<Superseded> {
    const task = await c.createTask(title, client);
    const proposal = await c.propose(task.id, task.revision, `f7_${randomUUID().slice(0, 8)}`);
    const old = heldFrom(await c.pickup(await c.approve(proposal)));
    const computing = await c.asAgent(
      'task.dispatch',
      { leaseId: old.leaseId, fence: old.fence },
      old.credential,
    );
    expect(computing.body['code'], 'the plan lease is in its compute phase').toBe(
      'LAUNCH_NOT_DECIDED',
    );
    const [row] = await c.fixture.db.admin.execute<{ readonly revision: string }>(
      `select revision::text as revision from public.records where id = $1`,
      [task.id],
    );
    const v2 = await c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: Number(row?.revision),
      ...PROPOSAL,
      purpose: `f7_v2_${randomUUID().slice(0, 8)}`,
      lineageId: proposal['lineageId'],
    });
    expect(v2.status, JSON.stringify(v2.body)).toBe(200);
    const replacement = heldFrom(await c.pickup(await c.approve(detailOf(v2))));
    return { taskId: task.id, lineageId: String(proposal['lineageId']), old, replacement };
  }

  /** Everything on the task but its reports: leases, holds, delegations, gates, money. */
  async function stateOf(work: Superseded): Promise<string> {
    const [row] = await c.fixture.db.admin.execute<{ readonly state: string }>(
      `select jsonb_build_object(
            'leases', (select jsonb_agg(to_jsonb(l) order by l.fence) from public.leases l
                        where l.task_id = $1),
            'delegations', (select jsonb_agg(to_jsonb(d) order by d.id) from public.delegations d
                             where d.id in (select delegation_id from public.leases
                                             where task_id = $1)),
            'reservations', (select jsonb_agg(to_jsonb(r) order by r.id) from public.reservations r
                              join public.planned_runs run on run.id = r.run_id
                             where run.lineage_id = $2),
            'attempts', (select jsonb_agg(to_jsonb(a) order by a.id) from public.attempts a
                          where a.lease_id in (select id from public.leases where task_id = $1)),
            'versions', (select jsonb_agg(to_jsonb(v) order by v.id) from public.proposal_versions v
                          where v.lineage_id = $2),
            'gates', (select jsonb_agg(to_jsonb(g) order by g.id) from public.gates g
                       join public.proposal_versions v on v.id = g.version_id
                      where v.lineage_id = $2),
            'envelopes', (select jsonb_agg(to_jsonb(e) order by e.id) from public.task_envelopes e
                           where e.task_id = $1),
            'committed', (select coalesce(sum(e.held_minor + e.actual_minor), 0)
                            from public.task_envelopes e),
            'task', (select to_jsonb(t) from public.records t where t.id = $1),
            'live', (select count(*) from public.delegations
                      where revoked_at is null and settled_at is null)
          )::text as state`,
      [work.taskId, work.lineageId],
    );
    return String(row?.state);
  }

  const reportsOn = async (...leases: readonly string[]): Promise<readonly Retained[]> =>
    await c.fixture.db.admin.execute<Retained>(
      `select lease_id::text as lease_id, reservation_id::text as reservation_id,
                run_id::text as run_id, fence::text as fence, disposition, outcome,
                refusal_code, report
           from public.handback_reports where lease_id = any($1::uuid[]) order by created_at`,
      [leases],
    );

  /** The attempt a lease serves, with its reservation: what a kept report binds to. */
  const attemptOn = async (leaseId: string) => {
    const { attemptId, runId } = await attemptOfLease(
      c.fixture.db.admin,
      c.fixture.business,
      leaseId,
    );
    const [row] = await c.fixture.db.admin.execute<{ readonly reservation_id: string }>(
      `select reservation_id::text as reservation_id from public.attempts where id = $1`,
      [attemptId],
    );
    return { attemptId, runId, reservationId: String(row?.reservation_id) };
  };

  const outcomesOn = async (leaseId: string): Promise<readonly OutcomeRow[]> =>
    await outcomesOfAttempt(
      c.fixture.db.admin,
      c.fixture.business,
      (await attemptOn(leaseId)).attemptId,
    );

  /** A POST on an agent door, under a bearer and the credential it presents. */
  const atAgentDoor = async (
    path: string,
    body: Readonly<Record<string, unknown>>,
    bearer: string,
    credential: string,
  ): Promise<Answer> =>
    await post(c.api, path, body, { ...authorised(bearer), 'x-agent-delegation': credential });

  // eslint-disable-next-line max-lines-per-function -- the late report, then each impostor on the same state
  it('keeps one unaccepted report bound to the old attempt, answers DELEGATION_NOT_LIVE and moves nothing, and no impostor keeps anything', async () => {
    const work = await superseded(clientX, 'superseded while it computed');
    const elsewhere = await superseded(clientY, "another client's superseded work");
    const oldAttempt = await attemptOn(work.old.leaseId);
    const recorded = await outcomesOn(work.old.leaseId);
    // R1: the supersession wrote the old attempt's one outcome; the replacement is live and idle.
    expect
      .soft(pairs(recorded), 'the supersession recorded the old outcome')
      .toStrictEqual([['cancelled', 'PLAN_SUPERSEDED']]);
    expect(await outcomesOn(work.replacement.leaseId), 'a live attempt has none').toStrictEqual([]);
    const before = await stateOf(work);
    const beforeElsewhere = await stateOf(elsewhere);

    // The old holder's late report, through its real door, on its own lease and credential.
    const sent = lateReport(work.old);
    const answer = await c.asAgent('task.handback', sent, work.old.credential);
    expect(answer.status, JSON.stringify(answer.body)).toBe(401);
    expect(answer.body['code']).toBe('DELEGATION_NOT_LIVE');
    expect(JSON.stringify(answer.body)).not.toContain('the reviewed output, for a person');
    // Driver rows carry no plain prototype, so rows compare by value.
    expect(await reportsOn(work.old.leaseId, work.replacement.leaseId)).toEqual([
      {
        lease_id: work.old.leaseId,
        reservation_id: oldAttempt.reservationId,
        run_id: oldAttempt.runId,
        fence: String(work.old.fence),
        disposition: 'retained',
        outcome: 'completed',
        refusal_code: 'DELEGATION_NOT_LIVE',
        report: sent['report'],
      },
    ]);
    expect(await stateOf(work), 'replacement, holds and money as they were').toBe(before);
    expect(await outcomesOn(work.old.leaseId), 'the old outcome as written').toStrictEqual(
      recorded,
    );
    expect(await outcomesOn(work.replacement.leaseId)).toStrictEqual([]);
    const kept = await reportsOn(work.old.leaseId, work.replacement.leaseId);

    // Each impostor sends the same report; none is the old holder on its own lease.
    const handback = agentPath('task.handback');
    // Each with the refusal its own binding gives: the code alone keeps nothing.
    const impostors: readonly (readonly [string, string, () => Promise<Answer>])[] = [
      [
        'a different agent presenting the old credential',
        'DELEGATION_NOT_LIVE',
        async () =>
          await atAgentDoor(handback, lateReport(work.old), strangerToken, work.old.credential),
      ],
      [
        "the old holder at a foreign business's door",
        'AUTH_NO_AGENT_IDENTITY',
        async () =>
          await atAgentDoor(
            '/api/a/b/bravo/task/handback',
            lateReport(work.old),
            agentToken,
            work.old.credential,
          ),
      ],
      [
        "the old credential with a foreign client's superseded lease",
        'DELEGATION_NOT_LIVE',
        async () =>
          await c.asAgent('task.handback', lateReport(elsewhere.old), work.old.credential),
      ],
      [
        'a person presenting the old lease at the agent door',
        'AUTH_NO_AGENT_IDENTITY',
        async () =>
          await atAgentDoor(handback, lateReport(work.old), personToken, work.old.credential),
      ],
      [
        'a person presenting the old lease at the person door',
        'LEASE_NOT_OWNED',
        async () => await c.asPerson('task.handback', lateReport(work.old)),
      ],
    ];
    for (const [who, code, send] of impostors) {
      // eslint-disable-next-line no-await-in-loop -- one impostor at a time, each checked
      const refused = await send();
      expect(refused.body['code'], `${who}: ${JSON.stringify(refused.body)}`).toBe(code);
      // eslint-disable-next-line no-await-in-loop -- the reports after each
      expect(await reportsOn(work.old.leaseId, work.replacement.leaseId), who).toEqual(kept);
      // eslint-disable-next-line no-await-in-loop
      expect(await reportsOn(elsewhere.old.leaseId, elsewhere.replacement.leaseId), who).toEqual(
        [],
      );
      // eslint-disable-next-line no-await-in-loop
      expect(await stateOf(work), who).toBe(before);
      // eslint-disable-next-line no-await-in-loop
      expect(await stateOf(elsewhere), who).toBe(beforeElsewhere);
      // eslint-disable-next-line no-await-in-loop
      expect(await outcomesOn(work.old.leaseId), who).toStrictEqual(recorded);
    }
  }, 180_000);

  it('control: the current holder hands back its own work, and it settles', async () => {
    const work = await superseded(clientX, 'superseded, then the replacement finishes');
    const recorded = await outcomesOn(work.old.leaseId);
    expect
      .soft(pairs(recorded), 'the supersession recorded the old outcome')
      .toStrictEqual([['cancelled', 'PLAN_SUPERSEDED']]);

    const sent = lateReport(work.replacement);
    const answer = await c.asAgent('task.handback', sent, work.replacement.credential);
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(detailOf(answer)['successorVersionId'], 'the reviewed output is proposed').toEqual(
      expect.any(String),
    );
    const reports = await reportsOn(work.old.leaseId, work.replacement.leaseId);
    expect(reports.map((row) => [row.lease_id, row.disposition, row.refusal_code])).toStrictEqual([
      [work.replacement.leaseId, 'settled', null],
    ]);
    expect(await outcomesOn(work.old.leaseId), 'the old outcome as written').toStrictEqual(
      recorded,
    );
    // R2: the review handback is the success writer of the attempt it settles.
    expect
      .soft(pairs(await outcomesOn(work.replacement.leaseId)), 'the review handback succeeded')
      .toStrictEqual([['success', 'COMPLETED']]);
  }, 180_000);
});
