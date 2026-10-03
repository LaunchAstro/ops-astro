// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, the delegation crossing: an agent working under a live
// delegation from another person reaches only the task it picked up, never a
// second Alpha person's own held reservation, live lease or run; and, as the
// control, reaches the same lease and run operations on its own task. Registered inside
// api-1-isolation.test.ts's describe, so it shares that file's world. Made-up
// names only.

import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import {
  delegatedTask,
  fixture,
  foreignLease,
  foreignPersonId,
  foreignReservation,
  foreignRunId,
  foreignTaskId,
  helperAgentId,
  label,
  ownLease,
  ownRunId,
  rows,
  task,
} from './api-1-isolation-world.ts';
import { SHAPE, asAgent, canonical, foreign, type Heard } from './api-1-isolation-surfaces.ts';

let attemptedForeignLeaseId = '';
let attemptedForeignReservationId = '';

/** The claim a lease or run operation is sent at: the other person's, or the agent's own. */
interface Claim {
  readonly lease: { readonly leaseId: string; readonly fence: unknown };
  readonly taskId: string;
  readonly runId: string;
}

/** A field write on `record`, at a revision the crossing never reaches. */
const written = (record: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  recordId: record,
  expectedRevision: 1,
  fields,
});

/**
 * An agent writes its own task's fields under a delegation (MP-4-7, MP-4-8): never
 * another person's task, another client's or another business's.
 */
const FIELD_WRITES: Record<string, (record: string) => Record<string, unknown>> = {
  'task.update': (record) => written(record, { title: 'made-up' }),
  'task.assign': (record) => written(record, { assignee: randomUUID() }),
  'task.set_adhoc': (record) => written(record, { ad_hoc: true }),
  'task.set_category': (record) => written(record, { category: 'seo' }),
  'task.set_scores': (record) => written(record, { impact: 7, confidence: 9, ease: 8 }),
  'task.edit_comment': (record) => ({
    recordId: record,
    expectedRevision: 1,
    commentId: randomUUID(),
    body: 'made-up',
  }),
  'task.delete_comment': (record) => ({
    recordId: record,
    expectedRevision: 1,
    commentId: randomUUID(),
  }),
};

/**
 * Each command's own target: a record, a lease, a reservation, or none. A lease
 * call names its task through its lease and ignores a record id beside it, so its
 * crossing is another Alpha person's live lease at its own fence (a second agent
 * holds it, under that person's delegation, not this one); a pickup's crossing is
 * that person's approved reservation, still held; the run's state, the run on that
 * person's picked-up task. The same bodies at the agent's own claim are the control.
 */
const bodies = (
  claim: Claim,
): Record<string, (record: string) => Record<string, unknown> | null> => ({
  'task.read': (record) => ({ recordId: record }),
  'task.comment': (record) => ({ recordId: record, body: 'made-up', audience: 'internal' }),
  'task.heartbeat': () => ({ ...claim.lease, leaseSeconds: 60 }),
  'task.handback': () => ({ ...claim.lease, outcome: 'completed', report: { wrote: 'made-up' } }),
  'task.pickup': () => ({ reservationId: attemptedForeignReservationId }),
  'task.propose': (record) => ({
    recordId: record,
    purpose: 'api_1_isolation',
    maximumMinor: 2_500,
    currency: 'AUD',
    payload: { instruction: 'made-up' },
    step: { kind: 'compose', payload: { tone: 'plain' } },
  }),
  'task.dispatch': () => ({ ...claim.lease }),
  'task.observe': () => ({ ...claim.lease, attemptId: randomUUID(), outcome: 'completed' }),
  'task.queue': () => null,
  ...FIELD_WRITES,
  'session.capabilities': () => null,
  'task.check': () => ({ ...claim.lease, name: 'made-up check', outcome: 'passed' }),
  'model.call': () => ({
    ...claim.lease,
    operation: 'compose',
    fields: [{ name: 'note', source: 'business_internal', value: 'made-up' }],
  }),
  // A real helper, and a set strictly narrower than the parent's, so only the
  // lease tells the crossing from the control.
  'run.delegate_child': () => ({
    ...claim.lease,
    helperActorId: helperAgentId,
    purpose: 'api_1_isolation',
    collections: ['task'],
    actions: ['read'],
    expiresInSeconds: 60,
  }),
  'run.revise_state': () => ({
    recordId: claim.taskId,
    runId: claim.runId,
    expectedVersion: 0,
    knowledge: ['made-up'],
    unknowns: [],
  }),
  // No crossing target: the helper's handback answers to its own child credential.
  'run.child_handback': () => ({ outcome: 'completed' }),
  // A credential's create (API-2): a pickup's one-task delegation never reaches it.
  'task.create': () => ({ fields: { title: 'made-up' } }),
});

/** The lease and run operations the delegation reaches only on its own task. */
const RUN_AND_LEASE = ['task.check', 'model.call', 'run.delegate_child', 'run.revise_state'];

// eslint-disable-next-line max-lines-per-function -- one crossing proof and its control
export function delegationCrossing(): void {
  // The proof's `claims` reads the world's module bindings.
  /* eslint-disable max-lines-per-function, unicorn/consistent-function-scoping */
  it('API-1 isolation: person to person under a live delegation, the agent reaches only its delegated task', async () => {
    const agentRows = rows.filter((row) => row.api.agent !== null);
    const read = agentRows.find((row) => row.command === 'task.read') as CatalogueRow;
    const own = await asAgent(read, 'alpha', { recordId: delegatedTask });
    expect(own.map((one) => one.status)).toEqual([200, 200]);
    expect(JSON.stringify(own[0]?.body)).toContain('<delegated task>');
    attemptedForeignLeaseId = foreignLease.leaseId;
    attemptedForeignReservationId = foreignReservation;
    // The other person's claims, and every row the lease and run operations write
    // on their task: checks, model calls, run states and child delegations.
    const claims = async () =>
      await fixture.db.admin.execute(
        `select l.state, l.fence::text, l.expires_at::text, r.state as reservation, r.lease_id,
                (select count(*) from public.run_checks c
                  where c.business_id = $1 and c.task_id = $4)::int as checks,
                (select count(*) from public.model_calls m
                   join public.planned_runs p on p.business_id = m.business_id and p.id = m.run_id
                  where m.business_id = $1 and p.task_id = $4)::int as model_calls,
                (select count(*) from public.run_states s
                  where s.business_id = $1 and s.task_id = $4)::int as run_states,
                (select count(*) from public.delegations d
                  where d.business_id = $1 and d.purpose_scope_id = $4)::int as delegations
           from public.leases l, public.reservations r
          where l.business_id = $1 and l.id = $2 and r.business_id = $1 and r.id = $3`,
        [fixture.business, foreignLease.leaseId, foreignReservation, foreignTaskId],
      );
    const before = await claims();
    expect(before).toHaveLength(1);
    const target = bodies({ lease: foreignLease, taskId: foreignTaskId, runId: foreignRunId });
    expect(Object.keys(target).toSorted()).toEqual(agentRows.map((row) => row.command).toSorted());
    // The lease and the run: the delegation's one task is not the other person's. The
    // pickup: one live delegation per agent and purpose, so a second task never joins
    // the first one's reach. The control below tells this from a collection refusal.
    const reason: Record<string, string> = {
      'task.heartbeat': 'DELEGATION_OUT_OF_PURPOSE',
      'task.handback': 'DELEGATION_OUT_OF_PURPOSE',
      'task.dispatch': 'DELEGATION_OUT_OF_PURPOSE',
      'task.observe': 'DELEGATION_OUT_OF_PURPOSE',
      ...Object.fromEntries(RUN_AND_LEASE.map((command) => [command, 'DELEGATION_OUT_OF_PURPOSE'])),
      'task.pickup': 'DELEGATION_ALREADY_LIVE',
      'task.create': 'DELEGATION_OUT_OF_PURPOSE',
    };
    for (const row of agentRows) {
      for (const [businessKey, other] of [
        ['alpha', task.client1],
        ['alpha', task.client2],
        ['bravo', task.bravo],
      ] as const) {
        const body = target[row.command]?.(other) ?? {};
        // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
        const heard = await asAgent(row, businessKey, body);
        const where = `${row.command} on ${businessKey}`;
        expect(heard, where).toHaveLength(2);
        expect(
          new Set(heard.map((one) => canonical(one))).size,
          `${where} ${JSON.stringify(heard)}`,
        ).toBe(1);
        // The queue is the business's outstanding work, which any agent login may read by
        // contract (agent-envelope.ts; minimum contract 8.2 case 9): the other person's
        // queued work shows there as ids, purpose and amount, never their title or their
        // person, and nothing of another business or client. Every other answer names none.
        const queued = row.command === 'task.queue' && businessKey === 'alpha';
        expect(foreign(heard, null), where).toEqual(queued ? ['other'] : []);
        if (queued) {
          const seen = JSON.stringify(heard);
          expect(seen, where).toContain('<other reservation>');
          expect(seen, where).not.toMatch(/<other (?:title|person|lease)>|<delegated title>/u);
        }
        if (target[row.command]?.(other) === null && businessKey === 'alpha') {
          expect(heard[0]?.status, where).toBe(200);
          continue;
        }
        expect(heard[0]?.status, where).toBeGreaterThanOrEqual(400);
        expect(SHAPE, where).not.toContain(heard[0]?.code);
        // Refused for the delegation's reason, not because the claim does not exist.
        if (businessKey === 'alpha' && row.command in reason) {
          expect(heard[0]?.code, where).toBe(reason[row.command]);
        }
      }
    }
    // Check first, then act: every refusal left the other person's claims as they were.
    expect(await claims()).toEqual(before);
  }, 60_000);

  it('API-1 isolation: the agent reaches the lease and run operations on its own delegated task', async () => {
    const ours = bodies({ lease: ownLease, taskId: delegatedTask, runId: ownRunId });
    for (const command of RUN_AND_LEASE) {
      const row = rows.find((one) => one.command === command) as CatalogueRow;
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await asAgent(row, 'alpha', ours[command]?.(delegatedTask) ?? {});
      const where = `${command} ${JSON.stringify(heard)}`;
      expect(
        heard.map((one) => one.code),
        where,
      ).not.toContain('DELEGATION_OUT_OF_PURPOSE');
      // Past the delegation and served; the model call answers that no broker is set.
      if (command === 'model.call') expect(heard[0]?.code, where).toBe('DEPENDENCY_NOT_LANDED');
      else expect(heard[0]?.status, where).toBe(200);
    }
  }, 60_000);
  /* eslint-enable max-lines-per-function, unicorn/consistent-function-scoping */
}

export function delegationCrossingTargets(): void {
  it("agent crossings use another person's live lease and held reservation", async () => {
    const leases = await fixture.db.admin.execute<{ person_id: string }>(
      `select authorised_by_person_id::text as person_id
         from public.leases where business_id = $1 and id = $2 and state = 'live'`,
      [fixture.business, attemptedForeignLeaseId],
    );
    expect
      .soft(leases[0]?.person_id, 'the heartbeat and handback target must be a live lease')
      .toBeDefined();
    expect(leases[0]?.person_id).not.toBe(fixture.member.personId);

    const reservations = await fixture.db.admin.execute<{ person_id: string }>(
      `select d.decided_by_person_id::text as person_id
         from public.reservations r
         join public.gate_decisions d on d.business_id = r.business_id and d.version_id = r.version_id
        where r.business_id = $1 and r.id = $2 and r.state = 'held' and r.lease_id is null`,
      [fixture.business, attemptedForeignReservationId],
    );
    expect
      .soft(
        reservations[0]?.person_id,
        "the pickup target must be another person's held reservation",
      )
      .toBeDefined();
    expect(reservations[0]?.person_id).not.toBe(fixture.member.personId);
  });

  it("another person's identifiers remain detectable", () => {
    const refused: Heard[] = [
      {
        status: 403,
        code: 'DELEGATION_OUT_OF_PURPOSE',
        body: label({ personId: foreignPersonId, recordId: foreignTaskId }),
      },
    ];
    expect.soft(foreign(refused, null)).toContain('other');
    expect.soft(label(foreignTaskId)).not.toEqual(label(delegatedTask));
  });
}
