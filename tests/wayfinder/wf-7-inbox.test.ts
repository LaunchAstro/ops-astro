// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Twice failed, it stops, reports on the ticket and raises one
// inbox item to the map's owner", and the tracked action `inbox item raised
// (waiting run)`: a system write under the worker lease, in the writing
// transaction. The run is main's proposal, approval and pickup on a research
// ticket of a map; the agent hands it back failed. INB-1's raise
// (`raiseRunSettled`) tells the launcher of each failed run; the second failed
// run on the ticket also tells the map's owner, once, and says so on the
// ticket. On the real commands against Postgres.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  codeOf,
  freshPurpose,
  handbackBody,
  openSchedules,
  pickup,
  proposeBody,
  revisionOf,
  seedSchedules,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let owner: Member;
let other: Schedules;
let otherOwner: Member;
/** Each business's second decider: the starter claims the ticket, and T2g refuses its own gate. */
const approvers = new Map<string, Member>();

/** A person of the business who charts maps: write across it, nothing else. */
const charter = async (w: Schedules, label: string): Promise<Member> => {
  const person = await enrol(w.db.app, w.business, label);
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, person, 'read', undefined, true);
    await grantTo(tx, person, 'write', undefined, true);
  });
  return person;
};

/** A map charted by `by`, with one research ticket the decider may run. */
const researchOnMap = async (w: Schedules, by: Member, title: string): Promise<string> => {
  const charted = await executeCommand(w.db.app, w.business, by.presented, 'api', {
    command: 'map.chart',
    operationId: randomUUID(),
    title,
    tickets: [{ ref: 'r1', title: `${title}: what is decided`, type: 'research' }],
  } as never);
  const ticket = String((appliedDetail(charted, 'map.chart')['tickets'] as Detail)['r1']);
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, w.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  return ticket;
};

/**
 * The approver holds the decider's delegable grants, because pickup mints the
 * agent's delegation from the approver's; the lease names them as its launcher.
 */
const approverOf = async (w: Schedules): Promise<Member> => {
  const known = approvers.get(w.business);
  if (known !== undefined) return known;
  const member = await enrol(w.db.app, w.business, 'wf7-approver');
  await w.db.app.withBusiness(w.business, async (tx) => {
    for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, member, action, undefined, true);
    }
  });
  approvers.set(w.business, member);
  return member;
};

const approve = async (w: Schedules, proposal: Detail): Promise<Detail> =>
  appliedDetail(
    await executeCommand(w.db.app, w.business, (await approverOf(w)).presented, 'api', {
      ...approveBody(proposal),
    } as never),
    'task.decide',
  );

/** Starting a run on the ticket as `by` (the decider unless named), at its live revision. */
const start = async (w: Schedules, ticket: string, by?: Member) => {
  const body = proposeBody(ticket, await revisionOf(w, ticket), { purpose: freshPurpose() });
  return by === undefined
    ? await asPerson(w, body)
    : await executeCommand(w.db.app, w.business, by.presented, 'api', body as never);
};

/** One research run on the ticket, started, approved, picked up by the agent. */
const runOn = async (
  w: Schedules,
  ticket: string,
  by?: Member,
): Promise<{ runId: string; picked: Detail }> => {
  const proposal = appliedDetail(await start(w, ticket, by), 'task.propose');
  const picked = await pickup(w, (await approve(w, proposal))['reservationId']);
  return { runId: String(proposal['runId']), picked };
};

/** The agent hands the run back failed, under its lease. */
const fail = async (w: Schedules, picked: Detail): Promise<void> => {
  appliedDetail(
    await asAgent(
      w,
      {
        ...handbackBody(picked),
        outcome: 'failed',
        report: { summary: 'the source would not load' },
      },
      String(picked['credential']),
    ),
    'task.handback',
  );
};

const failedRun = async (w: Schedules, ticket: string, by?: Member): Promise<string> => {
  const { runId, picked } = await runOn(w, ticket, by);
  await fail(w, picked);
  return runId;
};

interface Item {
  readonly recipient: string;
  readonly reason: string;
  readonly factKind: string;
  readonly factId: string;
}

/** Every open item on the ticket, in its business. */
const itemsOn = async (w: Schedules, ticket: string): Promise<Item[]> => [
  ...(await w.db.admin.execute<Item>(
    `select recipient_person_id as recipient, reason, fact_kind as "factKind", fact_id as "factId"
       from public.inbox_items
      where business_id = $1 and subject_record_id = $2 and work_state = 'open'
      order by raised_at, fact_kind, id`,
    [w.business, ticket],
  )),
];

/** Every open item a person holds in the business, whatever its subject. */
const itemsOf = async (w: Schedules, person: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.inbox_items
        where business_id = $1 and recipient_person_id = $2 and work_state = 'open'`,
      [w.business, person],
    )
  )[0]?.n ?? 0;

interface Said {
  readonly type: string;
  readonly audience: string;
  readonly body: string;
}

/** The comments on the ticket, oldest first. */
const commentsOn = async (w: Schedules, ticket: string): Promise<Said[]> => [
  ...(await w.db.admin.execute<Said>(
    `select r.data ->> 'comment_type' as type, r.data ->> 'audience' as audience,
            r.data ->> 'body' as body
       from public.records r
       join public.record_types t
         on t.business_id = r.business_id and t.id = r.record_type_id and t.key = 'task_comment'
      where r.business_id = $1 and r.data ->> 'task' = $2
      order by r.data ->> 'posted_at', r.id`,
    [w.business, ticket],
  )),
];

const runsOn = async (w: Schedules, ticket: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.planned_runs where business_id = $1 and task_id = $2',
      [w.business, ticket],
    )
  )[0]?.n ?? 0;

interface Ask {
  readonly recipient: string;
  readonly state: string;
  readonly closedBy: string | null;
}

/** The map owner's asks on the ticket (items about the ticket itself), oldest first. */
const asksOn = async (w: Schedules, ticket: string): Promise<Ask[]> => [
  ...(await w.db.admin.execute<Ask>(
    `select recipient_person_id as recipient, work_state as state,
            closed_by_person_id as "closedBy"
       from public.inbox_items
      where business_id = $1 and subject_record_id = $2
        and fact_kind = 'record' and fact_id = $2
      order by raised_at, id`,
    [w.business, ticket],
  )),
];

/** Run on the ticket for `member` too: the map's owner starts it again after a stop. */
const mayRun = async (w: Schedules, member: Member, ticket: string): Promise<void> => {
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, member, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
};

const STOPPED = { code: 'TRANSITION_NOT_PERMITTED', names: ['stopped'] };

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7inbox', 1_000_000);
  owner = await charter(s, 'map-owner');
  other = await seedSchedules(s.db, 'wf7inbox-b', 1_000_000);
  otherOwner = await charter(other, 'map-owner-b');
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 waiting item under the lease: a failed research run raises one waiting item to its launcher, in the handback, under the worker lease', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 waiting');
  const { runId, picked } = await runOn(s, ticket);
  // A handback the runtime refuses (a stale fence) settles nothing and raises nothing.
  const stale = await asAgent(
    s,
    { ...handbackBody(picked), fence: Number(picked['fence']) + 1, outcome: 'failed' },
    String(picked['credential']),
  );
  expect(codeOf(stale)).toBe('LEASE_NOT_OWNED');
  expect(await itemsOn(s, ticket)).toStrictEqual([]);
  // The agent holds the lease and no person's grant on the inbox: the raise is the system's.
  await fail(s, picked);
  const launcher = (await approverOf(s)).personId;
  expect(await itemsOn(s, ticket)).toStrictEqual([
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: runId },
  ]);
  // Once failed is not twice: the map's owner is not told, and the ticket carries no report.
  expect(await itemsOf(s, owner.personId)).toBe(0);
  expect(await commentsOn(s, ticket)).toStrictEqual([]);
}, 120_000);

it("WF-7 twice failed: the second failed run on a research ticket stops, reports on the ticket and raises one inbox item to the map's owner", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 twice');
  const first = await failedRun(s, ticket);
  const second = await failedRun(s, ticket);
  const launcher = (await approverOf(s)).personId;
  expect(await itemsOn(s, ticket)).toStrictEqual([
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: first },
    { recipient: launcher, reason: 'waiting_run', factKind: 'planned_run', factId: second },
    { recipient: owner.personId, reason: 'waiting_run', factKind: 'record', factId: ticket },
  ]);
  const said = await commentsOn(s, ticket);
  expect(said).toHaveLength(1);
  expect(said[0]).toMatchObject({ type: 'system', audience: 'internal' });
  expect(said[0]?.body).toMatch(/failed twice/u);
}, 180_000);

it("WF-7 twice failed isolation: a ticket's failures are its own, counted in its own business and told only to its own map's owner", async () => {
  // A map owner of this case's own, so the earlier cases' items are not counted here.
  const mine = await charter(s, 'map-owner-crossing');
  // Business to business: one failure each on two businesses' tickets is not twice.
  const here = await researchOnMap(s, mine, 'wf7 crossing here');
  const there = await researchOnMap(other, otherOwner, 'wf7 crossing there');
  await failedRun(s, here);
  await failedRun(other, there);
  expect(await itemsOf(s, mine.personId)).toBe(0);
  expect(await itemsOf(other, otherOwner.personId)).toBe(0);
  // Ticket to ticket, in one business: two tickets failing once each are not twice either.
  const beside = await researchOnMap(s, mine, 'wf7 crossing beside');
  await failedRun(s, beside);
  expect(await itemsOf(s, mine.personId)).toBe(0);
  // Twice on one ticket over there tells that business's owner alone.
  await failedRun(other, there);
  expect((await itemsOn(other, there)).map((item) => item.recipient)).toContain(
    otherOwner.personId,
  );
  expect(await itemsOf(s, mine.personId)).toBe(0);
  // Person to person: the launcher is told of each run, never as the map's owner.
  const launcher = (await approverOf(other)).personId;
  expect(
    (await itemsOn(other, there)).filter(
      (item) => item.recipient === launcher && item.factKind === 'record',
    ),
  ).toStrictEqual([]);
}, 180_000);

it('Sol proof, criterion WF-7 twice failed: after the second failure, a new run waits on the map owner', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 waits on owner');
  await mayRun(s, owner, ticket);
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // The decider's third start is refused and writes nothing: no run, no claim, no revision.
  const before = await revisionOf(s, ticket);
  expect(await start(s, ticket)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(2);
  expect(await revisionOf(s, ticket)).toBe(before);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  // The map's owner starts it: that is their decision, and it closes their item.
  await runOn(s, ticket, owner);
  expect(await runsOn(s, ticket)).toBe(3);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
  ]);
}, 180_000);

it('Sol proof, criterion WF-7 twice failed: two more failures after the owner clears the item ask again', async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 asks again');
  await mayRun(s, owner, ticket);
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // The owner looks and runs it again; it fails a third time, once since their decision.
  await failedRun(s, ticket, owner);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
  ]);
  expect(await commentsOn(s, ticket)).toHaveLength(1);
  // Once since is not twice: the decider may start it, and its failure is the second since.
  await failedRun(s, ticket);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'cleared', closedBy: owner.personId },
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  const said = await commentsOn(s, ticket);
  expect(said.map((comment) => comment.type)).toStrictEqual(['system', 'system']);
  // And it stops again.
  expect(await start(s, ticket)).toMatchObject(STOPPED);
  expect(await runsOn(s, ticket)).toBe(4);
}, 240_000);

it('WF-7 twice failed with no map owner: the report says no one was asked, and nothing waits on anyone', async () => {
  const created = await asPerson(s, {
    command: 'task.create',
    operationId: randomUUID(),
    fields: { title: 'wf7 no map' },
    taskType: 'research',
  });
  const ticket = String(
    appliedDetail(created, 'task.create') && (created as { recordId: string }).recordId,
  );
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  const said = await commentsOn(s, ticket);
  expect(said).toHaveLength(1);
  expect(said[0]?.body).toMatch(/failed twice/u);
  expect(said[0]?.body).not.toMatch(/owner has been asked/u);
  expect(await asksOn(s, ticket)).toStrictEqual([]);
  // No owner to wait on, so the ticket is not held for one.
  expect(codeOf(await start(s, ticket))).toBe('applied');
}, 180_000);

it("WF-7 twice failed isolation: another map's owner and another business's cannot start a stopped ticket", async () => {
  const ticket = await researchOnMap(s, owner, 'wf7 stopped crossing');
  await failedRun(s, ticket);
  await failedRun(s, ticket);
  // Map to map, in one business: the owner of another map, holding run:write here, is refused.
  const elsewhere = await charter(s, 'map-owner-elsewhere');
  await researchOnMap(s, elsewhere, 'wf7 stopped elsewhere');
  await mayRun(s, elsewhere, ticket);
  expect(await start(s, ticket, elsewhere)).toMatchObject(STOPPED);
  // Business to business: the other business's map owner reaches nothing here or from there.
  expect(codeOf(await start(s, ticket, otherOwner))).not.toBe('applied');
  const fromThere = await executeCommand(
    other.db.app,
    other.business,
    otherOwner.presented,
    'api',
    {
      ...proposeBody(ticket, await revisionOf(s, ticket), { purpose: freshPurpose() }),
    } as never,
  );
  expect(codeOf(fromThere)).not.toBe('applied');
  // Still stopped, still waiting on this map's owner, and nothing written.
  expect(await runsOn(s, ticket)).toBe(2);
  expect(await asksOn(s, ticket)).toStrictEqual([
    { recipient: owner.personId, state: 'open', closedBy: null },
  ]);
  expect(await start(s, ticket)).toMatchObject(STOPPED);
}, 180_000);
