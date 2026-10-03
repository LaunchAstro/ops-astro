// SPDX-License-Identifier: AGPL-3.0-only
//
// P26's low findings on the live correction's records (C80), each held
// on a real database through the application role, in a world of its own:
// one business with a decider, a requester, another member, an agent with a
// live lease on a task of client A, and a task of client B.
//
//   1. A credential ticked only for `task:write` covers no correction.
//   2. Storage holds a decision once made: no rejection turned approval, no
//      decider moved, nothing back to requested.
//   3. The receipt write needs the caller's own lease in a live delegation.
//   4. A correction's party is its task's client, never the one supplied.
//
// Registered through `tests/tenancy/restricted-calls.test.ts`, a named suite, after
// its own cases. Round 2 (`live-correction-lows-2.ts`) opens its own `describeWorld`.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { addClient, enrol, grantTo, WHOLE_BUSINESS, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approve,
  asPerson,
  createTask,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  revisionOf,
  type Schedules,
} from '../runtime/schedules-harness.ts';
import {
  insertLiveCorrection,
  listCoveredCorrections,
  lockCoveredCorrection,
  readCoveredDecision,
  recordObservedResult,
  writeCorrectionDecision,
  type LiveCorrection,
} from '../../packages/core-records/src/site/index.ts';
import type { Subject } from '../../packages/core-records/src/authority/grants.ts';
import type { TransactionQuery } from '../../packages/core-records/src/tenancy/transaction.ts';

export interface Lows {
  readonly s: Schedules;
  readonly requester: Member;
  readonly other: Member;
  readonly clientA: string;
  readonly clientB: string;
  /** Client A's task, which the agent holds a live lease on. */
  readonly taskA: string;
  readonly taskB: string;
  readonly leaseId: string;
  readonly fence: number;
}

let world: Lows | undefined;

export const lows = (): Lows => {
  if (world === undefined) throw new Error('the P26 world is not open');
  return world;
};

export const inBusiness = async <T>(run: (tx: TransactionQuery) => Promise<T>): Promise<T> =>
  await lows().s.db.app.withBusiness(lows().s.business, run);

export async function taskOf(s: Schedules, client: string): Promise<string> {
  const taskId = await createTask(s, `P26 correction task ${randomUUID()}`);
  appliedDetail(
    await asPerson(s, {
      command: 'task.set_party',
      operationId: randomUUID(),
      recordId: taskId,
      expectedRevision: await revisionOf(s, taskId),
      fields: { client },
    }),
    'task.set_party',
  );
  return taskId;
}

async function openLows(part: string): Promise<Lows> {
  const s = await openSchedules(part, 1_000_000);
  const requester = await enrol(s.db.app, s.business, 'requester');
  const other = await enrol(s.db.app, s.business, 'other');
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'share');
    await grantTo(tx, s.decider, 'write', WHOLE_BUSINESS, false, 'run');
    await grantTo(tx, s.decider, 'decide', WHOLE_BUSINESS, false, 'gate');
  });
  const [clientA, clientB] = [randomUUID(), randomUUID()];
  await addClient(s.db.app, s.business, clientA, s.decider);
  await addClient(s.db.app, s.business, clientB, s.decider);
  const taskA = await taskOf(s, clientA);
  const taskB = await taskOf(s, clientB);
  const proposal = await propose(s, taskA, { maximumMinor: 1_000, purpose: freshPurpose() });
  const picked = await pickup(s, (await approve(s, proposal))['reservationId']);
  const [leaseId, fence] = [String(picked['leaseId']), Number(picked['fence'])];
  return { s, requester, other, clientA, clientB, taskA, taskB, leaseId, fence };
}

/** A request by the requester on `taskId` under `partyId`, as the record layer answers it. */
export async function file(taskId: string, partyId: string): Promise<unknown> {
  const { requester } = lows();
  return await inBusiness(
    async (tx) =>
      await insertLiveCorrection(tx, {
        partyId,
        taskId,
        requestedByActorId: requester.actorId,
        requestedByPersonId: requester.personId,
        delegationId: null,
        targetPath: 'src/pages/about.md',
        word: 'friendly',
        replacement: 'welcoming',
        pageUrl: 'https://agency.example/about/',
        preImageDigest: 'sha256:pre',
        baseRevision: 'rev-1',
        seam: 'seam-p26',
        versionDigest: 'sha256:version',
      }),
  );
}

/** A stored request on client A's task, decided by the decider when a decision is named. */
export async function filed(decision?: 'approved' | 'rejected'): Promise<LiveCorrection> {
  const made = await file(lows().taskA, lows().clientA);
  if (typeof made !== 'object' || made === null || !('id' in made)) {
    throw new Error(`the request was refused: ${JSON.stringify(made)}`);
  }
  const correction = made as LiveCorrection;
  if (decision === undefined) return correction;
  const { decider } = lows().s;
  return await inBusiness(
    async (tx) =>
      await writeCorrectionDecision(tx, {
        id: correction.id,
        decision,
        actorId: decider.actorId,
        personId: decider.personId,
      }),
  );
}

export async function stateOf(id: string): Promise<string | undefined> {
  const rows = await lows().s.db.admin.execute<{ readonly state: string }>(
    'select state from public.live_corrections where id = $1',
    [id],
  );
  return rows[0]?.state;
}

export async function countOf(sql: string, id: string): Promise<number> {
  const rows = await lows().s.db.admin.execute<{ readonly n: number }>(sql, [id]);
  return Number(rows[0]?.n);
}

export const RECEIPTS =
  'select count(*)::int as n from public.live_correction_receipts where correction_id = $1';

function findingOne(): void {
  it('a subject ticked only for task:write covers no correction: list, lock and read', async () => {
    const { id } = await filed();
    const personId = lows().s.decider.personId;
    const whole: readonly Subject[] = [{ kind: 'person', id: personId }];
    const ticked: readonly Subject[] = [{ kind: 'person', id: personId, within: ['task:write'] }];
    const reach = async (subjects: readonly Subject[]) =>
      await inBusiness(async (tx) => ({
        listed: (await listCoveredCorrections(tx, subjects)).some((c) => c.id === id),
        locked:
          (await lockCoveredCorrection(tx, id, {
            subjects,
            collection: 'gate',
            action: 'decide',
          })) !== undefined,
        read:
          (await readCoveredDecision(tx, id, { subjects, collection: 'run', action: 'write' })) !==
          undefined,
      }));
    // The control: the same person's grants, asked within every key, cover it.
    expect(await reach(whole)).toStrictEqual({ listed: true, locked: true, read: true });
    expect(await reach(ticked)).toStrictEqual({ listed: false, locked: false, read: false });
  });
}

function findingTwo(): void {
  const refusedUpdate = async (id: string, set: string, parameters: readonly unknown[] = []) =>
    await expect(
      inBusiness(
        async (tx) =>
          await tx.query(
            `update public.live_corrections set ${set} where business_id = $1 and id = $2`,
            [lows().s.business, id, ...parameters],
          ),
      ),
    ).rejects.toThrow(/live_corrections_pinned: correction .* (keeps its decision|cannot move)/u);

  it('a raw update flipping a rejection to an approval is refused', async () => {
    const { id } = await filed('rejected');
    await refusedUpdate(id, `state = 'approved'`);
    expect(await stateOf(id)).toBe('rejected');
  });

  it('a raw update moving the decider, or clearing the decision back to requested, is refused', async () => {
    const { id } = await filed('approved');
    await refusedUpdate(id, 'decided_by_person_id = $3', [lows().other.personId]);
    await refusedUpdate(
      id,
      `state = 'requested', decided_by_actor_id = null, decided_by_person_id = null,
       decided_at = null, decided_version_digest = null`,
    );
    expect(await stateOf(id)).toBe('approved');
  });
}

function findingThree(): void {
  const observe = async (
    correctionId: string,
    actorId: string,
    step: 'publish' | 'revert',
    outcome: 'live' | 'failed' | 'reverted',
  ) => {
    const { leaseId, fence } = lows();
    // Built apart from the call, so the case also compiles against a write that takes no actor.
    const result = {
      correctionId,
      leaseId,
      fence,
      actorId,
      step,
      outcome,
      observations: { seen: outcome },
    };
    return await inBusiness(async (tx) => await recordObservedResult(tx, result));
  };
  const refused = { ok: false, code: 'LEASE_NOT_OWNED' };

  it('a live lease held by another actor refuses the receipt write and writes nothing', async () => {
    const { id } = await filed('approved');
    expect(await observe(id, lows().s.decider.actorId, 'publish', 'live')).toStrictEqual(refused);
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['approved', 0]);
    // The control: the holder writes it, and every move the record layer makes passes storage.
    const agent = lows().s.agentActorId;
    expect(await observe(id, agent, 'publish', 'live')).toMatchObject({ ok: true, state: 'live' });
    expect(await observe(id, agent, 'revert', 'failed')).toMatchObject({ ok: true, state: 'live' });
    expect(await observe(id, agent, 'revert', 'reverted')).toMatchObject({
      ok: true,
      state: 'reverted',
    });
  });

  it('a live lease whose delegation is revoked refuses the receipt write and writes nothing', async () => {
    const { id } = await filed('approved');
    await lows().s.db.admin.execute(
      `update public.delegations set revoked_at = now()
        where id = (select delegation_id from public.leases where id = $1)`,
      [lows().leaseId],
    );
    expect(await observe(id, lows().s.agentActorId, 'publish', 'live')).toStrictEqual(refused);
    expect([await stateOf(id), await countOf(RECEIPTS, id)]).toStrictEqual(['approved', 0]);
  });
}

function findingFour(): void {
  const OF_TASK_B = 'select count(*)::int as n from public.live_corrections where task_id = $1';

  it('a correction filed under client A for a task of client B is refused and writes nothing', async () => {
    const { taskB, clientA, clientB } = lows();
    expect(await file(taskB, clientA)).toStrictEqual({
      ok: false,
      code: 'CORRECTION_PARTY_MISMATCH',
    });
    expect(await countOf(OF_TASK_B, taskB)).toBe(0);
    // The control: under the task's own client it is stored, at that party.
    expect(await file(taskB, clientB)).toMatchObject({ taskId: taskB, partyId: clientB });
  });
}

/** `cases` over a world of its own (database `part`), opened first and dropped after. */
export function describeWorld(name: string, part: string, cases: () => void): void {
  describe.skipIf(databaseUrlFromEnvironment() === undefined)(name, () => {
    beforeAll(async () => {
      world = await openLows(part);
    }, 180_000);
    afterAll(async () => await world?.s.db.drop());
    cases();
  });
}

/** P26's findings, each its own block over one world. */
export function describeLiveCorrectionLows(): void {
  describeWorld('P26 lows: the live correction records', 'p26lows', () => {
    describe('finding 1: covered reads ask only the ticked keys', findingOne);
    describe('finding 2: storage holds a decision once made', findingTwo);
    describe('finding 3: the receipt write needs the caller’s own live lease', findingThree);
    describe('finding 4: the party is the task’s client', findingFour);
  });
}
