// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, the delegation crossing: an agent working under a live
// delegation from another person reaches only the task it picked up, never a
// second Alpha person's own held reservation or live lease. Registered inside
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
  foreignTaskId,
  label,
  rows,
  task,
} from './api-1-isolation-world.ts';
import { SHAPE, asAgent, canonical, foreign, type Heard } from './api-1-isolation-surfaces.ts';

let attemptedForeignLeaseId = '';
let attemptedForeignReservationId = '';

// eslint-disable-next-line max-lines-per-function -- one crossing proof, kept byte for byte
export function delegationCrossing(): void {
  // The proof is kept byte for byte; its `claims` reads the world's module bindings.
  /* eslint-disable max-lines-per-function, unicorn/consistent-function-scoping */
  it('API-1 isolation: person to person under a live delegation, the agent reaches only its delegated task', async () => {
    const agentRows = rows.filter((row) => row.api.agent !== null);
    const read = agentRows.find((row) => row.command === 'task.read') as CatalogueRow;
    const own = await asAgent(read, 'alpha', { recordId: delegatedTask });
    expect(own.map((one) => one.status)).toEqual([200, 200]);
    expect(JSON.stringify(own[0]?.body)).toContain('<delegated task>');
    // Each command's own target: a record, a lease, a reservation, or none. A lease
    // call names its task through its lease and ignores a record id beside it, so its
    // crossing is another Alpha person's live lease at its own fence (the same agent
    // holds it, under that person's delegation, not this one); a pickup's crossing is
    // that person's approved reservation, still held.
    const notOwnLease = foreignLease;
    attemptedForeignLeaseId = notOwnLease.leaseId;
    attemptedForeignReservationId = foreignReservation;
    const claims = async () =>
      await fixture.db.admin.execute(
        `select l.state, l.fence::text, l.expires_at::text, r.state as reservation, r.lease_id
           from public.leases l, public.reservations r
          where l.business_id = $1 and l.id = $2 and r.business_id = $1 and r.id = $3`,
        [fixture.business, foreignLease.leaseId, foreignReservation],
      );
    const before = await claims();
    expect(before).toHaveLength(1);
    const target: Record<string, (record: string) => Record<string, unknown> | null> = {
      'task.read': (record) => ({ recordId: record }),
      'task.comment': (record) => ({ recordId: record, body: 'made-up', audience: 'internal' }),
      'task.heartbeat': () => ({ ...notOwnLease, leaseSeconds: 60 }),
      'task.handback': () => ({
        ...notOwnLease,
        outcome: 'completed',
        report: { wrote: 'made-up' },
      }),
      'task.pickup': () => ({ reservationId: attemptedForeignReservationId }),
      'task.propose': (record) => ({
        recordId: record,
        purpose: 'api_1_isolation',
        maximumMinor: 2_500,
        currency: 'AUD',
        payload: { instruction: 'made-up' },
        step: { kind: 'compose', payload: { tone: 'plain' } },
      }),
      'task.dispatch': () => ({ ...notOwnLease }),
      'task.observe': () => ({ ...notOwnLease, attemptId: randomUUID(), outcome: 'completed' }),
      'task.queue': () => null,
      'session.capabilities': () => null,
      // The stack's run and model operations: the lease ones at the other
      // person's lease, the run's state on the crossing's task, and a child
      // handback from an agent that holds no child credential.
      'task.check': () => ({ ...notOwnLease, name: 'made-up check', outcome: 'passed' }),
      'model.call': () => ({
        ...notOwnLease,
        operation: 'compose',
        fields: [{ name: 'note', source: 'business_internal', value: 'made-up' }],
      }),
      'run.delegate_child': () => ({
        ...notOwnLease,
        helperActorId: randomUUID(),
        purpose: 'api_1_isolation',
        collections: ['run'],
        actions: ['read'],
        expiresInSeconds: 60,
      }),
      'run.revise_state': (record) => ({
        recordId: record,
        runId: randomUUID(),
        expectedVersion: 0,
        knowledge: ['made-up'],
        unknowns: [],
      }),
      'run.child_handback': () => ({ outcome: 'completed' }),
    };
    expect(Object.keys(target).toSorted()).toEqual(agentRows.map((row) => row.command).toSorted());
    // The lease: the delegation's one task is not the other lease's. The pickup: one live
    // delegation per agent and purpose, so a second task never joins the first one's reach.
    const reason: Record<string, string> = {
      'task.heartbeat': 'DELEGATION_OUT_OF_PURPOSE',
      'task.handback': 'DELEGATION_OUT_OF_PURPOSE',
      'task.dispatch': 'DELEGATION_OUT_OF_PURPOSE',
      'task.observe': 'DELEGATION_OUT_OF_PURPOSE',
      'task.pickup': 'DELEGATION_ALREADY_LIVE',
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
