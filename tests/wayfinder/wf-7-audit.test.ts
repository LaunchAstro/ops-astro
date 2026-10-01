// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640) "Every change it makes is recorded, and the audited ones join
// the audit chain; shown by a named test that makes each change and reads its
// record back." A research run on a map's ticket, made the way a person and
// the agent make it: started (and so claimed), approved, picked up, resolved
// with its answer and gist; and on a second ticket, failed twice. The map's
// owner reads each ticket back through `task.read`, whose history is the
// ticket's applied audit events, and the chain they joined verifies. Nothing
// of another business's run, or of the ticket beside, is read back.
// A proof, not a build: the rows were there. A handback, failed or not, names
// no subject, so a failure is read back in the chain by its operation id and
// on the ticket as its report. `ceiling approved (map, research)` waits on the
// research ceiling (wf-7-held).

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it as vitestIt } from 'vitest';
import {
  readAuditEvents,
  verifyAuditChain,
} from '../../packages/core-commands/src/commands/audit.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import { executeRead } from '../../packages/core-commands/src/reads/execute.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
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
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';

/** Every case needs the database; without one the file is skipped. */
const noDatabase = databaseUrlFromEnvironment() === undefined;
const it = noDatabase ? vitestIt.skip : vitestIt;

let s: Schedules;
let other: Schedules;
const owners = new Map<string, Member>();
const approvers = new Map<string, Member>();

/** A person of the business holding `actions` across it. */
const member = async (
  w: Schedules,
  label: string,
  actions: readonly Parameters<typeof grantTo>[2][],
): Promise<Member> => {
  const person = await enrol(w.db.app, w.business, label);
  await w.db.app.withBusiness(w.business, async (tx) => {
    for (const action of actions) {
      // oxlint-disable-next-line no-await-in-loop
      await grantTo(tx, person, action, undefined, true);
    }
  });
  return person;
};

const ownerOf = (w: Schedules): Member => owners.get(w.business) as Member;
const approverOf = (w: Schedules): Member => approvers.get(w.business) as Member;

/** A research ticket on a map the owner charted, which the decider may run. */
const researchOnMap = async (w: Schedules, title: string): Promise<string> => {
  const charted = await executeCommand(w.db.app, w.business, ownerOf(w).presented, 'api', {
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

/** Started by the decider (which claims it), approved by the approver, picked up by the agent. */
const runOn = async (w: Schedules, ticket: string): Promise<Detail> => {
  const proposal = appliedDetail(
    await asPerson(
      w,
      proposeBody(ticket, await revisionOf(w, ticket), { purpose: freshPurpose() }),
    ),
    'task.propose',
  );
  const decided = appliedDetail(
    await executeCommand(w.db.app, w.business, approverOf(w).presented, 'api', {
      ...approveBody(proposal),
    } as never),
    'task.decide',
  );
  return await pickup(w, decided['reservationId']);
};

const resolve = async (w: Schedules, ticket: string, picked: Detail): Promise<void> => {
  appliedDetail(
    await asAgent(
      w,
      {
        command: 'task.resolve',
        operationId: randomUUID(),
        recordId: ticket,
        expectedRevision: await revisionOf(w, ticket),
        answer: 'The cited answer [1].',
        gist: 'Answered, with one source.',
      },
      String(picked['credential']),
    ),
    'task.resolve',
  );
};

/** The agent hands the run back failed; the handback's operation id, as the chain names it. */
const fail = async (w: Schedules, picked: Detail): Promise<string> => {
  const operationId = randomUUID();
  const body = {
    ...handbackBody(picked),
    operationId,
    outcome: 'failed',
    report: { summary: 'no source loaded' },
  };
  appliedDetail(await asAgent(w, body, String(picked['credential'])), 'task.handback');
  return operationId;
};

interface Line {
  readonly operation: string;
  readonly actorId: string;
}

interface ReadBack {
  readonly history: readonly Line[];
  readonly assignee: string | null;
  readonly comments: readonly { readonly type: string; readonly body: string }[];
}

/** The ticket as `who` reads it back through `task.read`, or the refusal's code. */
const readBack = async (w: Schedules, who: Member, ticket: string): Promise<ReadBack | string> => {
  const answer = await executeRead(w.db.app, w.business, who.presented, {
    read: 'task.read',
    recordId: ticket,
  } as never);
  if (isCommandRefusal(answer)) return answer.code;
  const { task } = answer as unknown as {
    task: {
      history: readonly Line[];
      assignee: { personId: string } | null;
      comments: readonly { comment_type: string; body: string }[];
    };
  };
  return {
    history: task.history.map(({ operation, actorId }) => ({ operation, actorId })),
    assignee: task.assignee?.personId ?? null,
    comments: task.comments.map((c) => ({ type: c.comment_type, body: c.body })),
  };
};

/** The business's chain as the audit read gives it. */
const chainOf = async (w: Schedules) =>
  await w.db.app.withBusiness(w.business, (tx) => readAuditEvents(tx));

const intact = async (w: Schedules): Promise<boolean> =>
  (await w.db.app.withBusiness(w.business, (tx) => verifyAuditChain(tx))).intact;

/** A research ticket run to its answer: started, approved, picked up and resolved. */
const answeredOn = async (w: Schedules, title: string): Promise<string> => {
  const ticket = await researchOnMap(w, title);
  await resolve(w, ticket, await runOn(w, ticket));
  return ticket;
};

beforeAll(async () => {
  if (noDatabase) return;
  s = await openSchedules('wf7audit', 1_000_000);
  other = await seedSchedules(s.db, 'wf7audit-b', 1_000_000);
  for (const w of [s, other]) {
    // oxlint-disable-next-line no-await-in-loop
    owners.set(w.business, await member(w, 'map-owner', ['read', 'write']));
    approvers.set(
      w.business,
      // oxlint-disable-next-line no-await-in-loop
      await member(w, 'approver', ['read', 'write', 'decide', 'assign', 'comment']),
    );
  }
}, 180_000);
afterAll(async () => await s?.db.drop());

it('WF-7 audit readback: the map owner reads back the run started, picked up and resolved on its ticket, each by who made it, and the chain verifies', async () => {
  const ticket = await answeredOn(s, 'wf7 audit answered');
  const read = await readBack(s, ownerOf(s), ticket);
  expect(read).toMatchObject({
    history: [
      { operation: 'task.propose', actorId: s.decider.actorId },
      { operation: 'task.pickup', actorId: s.agentActorId },
      { operation: 'task.resolve', actorId: s.agentActorId },
    ],
    // The claim is the start's, in its transaction: the starter holds the ticket.
    assignee: s.decider.personId,
  });
  // Each line is one applied write about the ticket, in the chain, in order (reads are audited too).
  const events = (await chainOf(s)).filter(
    (e) => e.subject_record_id === ticket && e.command !== 'task.read',
  );
  expect(events.map((e) => [e.command, e.outcome])).toStrictEqual([
    ['task.propose', 'applied'],
    ['task.pickup', 'applied'],
    ['task.resolve', 'applied'],
  ]);
  expect(await intact(s)).toBe(true);
}, 120_000);

it('WF-7 audit readback: a run failed twice is read back: both starts on its ticket, both handbacks in the chain, its report on the ticket', async () => {
  const ticket = await researchOnMap(s, 'wf7 audit failed');
  const handbacks = [await fail(s, await runOn(s, ticket)), await fail(s, await runOn(s, ticket))];
  const read = await readBack(s, ownerOf(s), ticket);
  if (typeof read === 'string') throw new Error(`the owner was refused ${read}`);
  const started = { operation: 'task.propose', actorId: s.decider.actorId };
  const picked = { operation: 'task.pickup', actorId: s.agentActorId };
  expect(read.history).toStrictEqual([started, picked, started, picked]);
  expect(read.comments).toHaveLength(1);
  expect(read.comments[0]?.type).toBe('system');
  expect(read.comments[0]?.body).toMatch(/failed twice/u);
  const chain = await chainOf(s);
  for (const operationId of handbacks) {
    expect(
      chain
        .filter((e) => e.operation_id === operationId)
        .map((e) => [e.command, e.outcome, e.actor_id]),
    ).toStrictEqual([['task.handback', 'applied', s.agentActorId]]);
  }
  expect(await intact(s)).toBe(true);
}, 180_000);

it("WF-7 audit readback isolation: another business's run is not read back, nor is a ticket read back to a person without it", async () => {
  const here = await answeredOn(s, 'wf7 audit here');
  const there = await answeredOn(other, 'wf7 audit there');
  // Its own owner reads it back: the run is recorded over there.
  expect(await readBack(other, ownerOf(other), there)).toMatchObject({
    history: [
      { operation: 'task.propose', actorId: other.decider.actorId },
      { operation: 'task.pickup', actorId: other.agentActorId },
      { operation: 'task.resolve', actorId: other.agentActorId },
    ],
  });
  // Business to business: this owner names that ticket and reads nothing back.
  expect(await readBack(s, ownerOf(s), there)).toBe('NOT_FOUND');
  // The probe itself is this business's to see, refused; nothing of the run over there is.
  const mine = await chainOf(s);
  expect(
    mine.filter((e) => e.subject_record_id === there).map((e) => [e.command, e.outcome]),
  ).toStrictEqual([['task.read', 'refused']]);
  const theirs = new Set((await chainOf(other)).map((e) => e.id));
  expect(mine.some((e) => theirs.has(e.id))).toBe(false);
  // Person to person: a member of this business with no grant on the ticket reads nothing back.
  const stranger = await enrol(s.db.app, s.business, 'wf7-audit-stranger');
  const refused = await readBack(s, stranger, here);
  expect(typeof refused).toBe('string');
  expect(JSON.stringify(refused)).not.toContain('task.resolve');
  expect(await intact(s)).toBe(true);
  expect(await intact(other)).toBe(true);
}, 180_000);
