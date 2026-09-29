// SPDX-License-Identifier: AGPL-3.0-only
//
// API-1 isolation, against the real boundary and a fresh Postgres: for every
// command in the catalogue, the CLI and the API answer a caller exactly as the
// app's own client does, so no surface reads a row, or skips a grant, the app
// refuses. Two businesses, Alpha and Bravo, and in Alpha two tasks standing for
// two clients' work, each with one person holding one grant on it alone; and
// an agent working under a live delegation from another person, which reaches
// only the task it picked up, never a second Alpha person's own held reservation
// or live lease. Made-up names only.
//
// The world (businesses, people, the delegation and its claims) is set up in
// api-1-isolation-world.ts; the three surfaces and the leak check are in
// api-1-isolation-surfaces.ts.

import { describe, expect, it, vi } from 'vitest';
import type { CatalogueRow } from '../../packages/core-wire/src/index.ts';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import {
  api,
  bravoBusinessId,
  clientOne,
  clientTwo,
  delegatedTask,
  fixture,
  foreignLease,
  foreignPersonId,
  foreignReservation,
  foreignTaskId,
  label,
  rows,
  task,
  useIsolationWorld,
} from './api-1-isolation-world.ts';
import {
  SHAPE,
  asAgent,
  canonical,
  foreign,
  threeWays,
  type Heard,
} from './api-1-isolation-surfaces.ts';

const serverUrl = databaseUrlFromEnvironment();

it('a refusal carrying another client record is detected', () => {
  const refused: Heard[] = [
    { status: 403, code: 'SCOPE_NOT_GRANTED', body: { recordId: '<client2 task>' } },
  ];
  expect(foreign(refused, 'client1')).toEqual(['client2']);
});

let attemptedForeignLeaseId = '';
let attemptedForeignReservationId = '';

describe.skipIf(serverUrl === undefined)('API-1 isolation', () => {
  useIsolationWorld();
  businessAndClientCrossings();
  delegationCrossing();
  delegationCrossingTargets();
  leaksInSuccessfulReads();
  refusalsNameNoForeignRecord();
});

function businessAndClientCrossings(): void {
  it('API-1 isolation: business to business, every command answers the same refusal on every surface', async () => {
    for (const row of rows) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, fixture.member, 'bravo', { recordId: task.bravo });
      expect(heard, row.command).toHaveLength(3);
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, null), row.command).toEqual([]);
    }
  }, 60_000);

  it('API-1 isolation: client to client, a grant on one task reads nothing of the other on any surface', async () => {
    const reads = rows.filter(
      (row) => row.kind === 'read' && row.command === ('task.read' as CommandName),
    );
    for (const [member, own, other, name] of [
      [clientOne, task.client1, task.client2, 'client1'],
      [clientTwo, task.client2, task.client1, 'client2'],
    ] as const) {
      for (const row of reads) {
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const allowed = await threeWays(row, member, 'alpha', { recordId: own });
        expect(allowed.map((one) => one.status)).toEqual([200, 200, 200]);
        expect(new Set(allowed.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(JSON.stringify(allowed[0]?.body)).toContain(`<${name} task>`);
        expect(foreign(allowed, name)).toEqual([]);
        // eslint-disable-next-line no-await-in-loop -- each person in turn
        const refused = await threeWays(row, member, 'alpha', { recordId: other });
        expect(new Set(refused.map((one) => JSON.stringify(one))).size).toBe(1);
        expect(refused[0]?.status).toBeGreaterThanOrEqual(400);
      }
    }
    // And every write, as the person holding read alone on their own task: refused alike everywhere.
    for (const row of rows.filter((one) => one.kind === 'write')) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time reads as a list
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client2 });
      expect(new Set(heard.map((one) => JSON.stringify(one))).size, row.command).toBe(1);
      expect(heard[0]?.status, row.command).toBeGreaterThanOrEqual(400);
      expect(foreign(heard, 'client1'), row.command).toEqual([]);
    }
  }, 60_000);
}

// eslint-disable-next-line max-lines-per-function -- one crossing proof, kept byte for byte
function delegationCrossing(): void {
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
      'task.queue': () => null,
      'session.capabilities': () => null,
    };
    expect(Object.keys(target).toSorted()).toEqual(agentRows.map((row) => row.command).toSorted());
    // The lease: the delegation's one task is not the other lease's. The pickup: one live
    // delegation per agent and purpose, so a second task never joins the first one's reach.
    const reason: Record<string, string> = {
      'task.heartbeat': 'DELEGATION_OUT_OF_PURPOSE',
      'task.handback': 'DELEGATION_OUT_OF_PURPOSE',
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

function delegationCrossingTargets(): void {
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

function leaksInSuccessfulReads(): void {
  it('API-1 isolation: a successful read carrying the other client record is caught', async () => {
    const row = rows.find((one) => one.command === 'task.read') as CatalogueRow;
    const leaked = vi
      .spyOn(api, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ recordId: task.client2, fields: { title: 'x' } })),
      );
    try {
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
      expect(heard.map((one) => one.status)).toEqual([200, 200, 200]);
      expect(foreign(heard, 'client1')).toEqual(['client2']);
    } finally {
      leaked.mockRestore();
    }
  });

  it('isolation sees leaked client data in successful reads', async () => {
    const row = rows.find((one) => one.command === 'task.read');
    if (row === undefined) throw new Error('task.read is missing from the catalogue');
    const leaked = vi
      .spyOn(api, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ recordId: task.client2, fields: { title: 'other client secret' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      );
    try {
      const heard = await threeWays(row, clientOne, 'alpha', { recordId: task.client1 });
      expect(heard).toHaveLength(3);
      expect(heard[0]).toHaveProperty('body');
      expect(JSON.stringify(heard)).not.toContain(task.client2);
    } finally {
      leaked.mockRestore();
    }
  });
}

function refusalsNameNoForeignRecord(): void {
  it('refusals expose no foreign business or person record', () => {
    const heard: Heard[] = [
      {
        status: 403,
        code: 'SCOPE_NOT_GRANTED',
        body: label({ businessId: bravoBusinessId, personId: clientTwo.personId }),
      },
    ];
    expect(foreign(heard, 'client1')).toEqual(['bravo', 'client2']);
  });
}
