// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7's twice-failed cases share these: a research ticket on a map, its run
// started, picked up and handed back failed, and the reads that check what
// the failures left (items, comments, runs, asks). On the real commands.

import { randomUUID } from 'node:crypto';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  appliedDetail,
  approveBody,
  asAgent,
  asPerson,
  freshPurpose,
  handbackBody,
  pickup,
  proposeBody,
  revisionOf,
  type Detail,
  type Schedules,
} from '../runtime/schedules-harness.ts';

/** Each business's second decider: the starter claims the ticket, and T2g refuses its own gate. */
const approvers = new Map<string, Member>();

/** A person of the business who charts maps: write across it, nothing else. */
export const charter = async (w: Schedules, label: string): Promise<Member> => {
  const person = await enrol(w.db.app, w.business, label);
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, person, 'read', undefined, true);
    await grantTo(tx, person, 'write', undefined, true);
  });
  return person;
};

/** A map charted by `by`, with one research ticket the decider may run. */
export const researchOnMap = async (w: Schedules, by: Member, title: string): Promise<string> => {
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
export const approverOf = async (w: Schedules): Promise<Member> => {
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

export const approve = async (w: Schedules, proposal: Detail): Promise<Detail> =>
  appliedDetail(
    await executeCommand(w.db.app, w.business, (await approverOf(w)).presented, 'api', {
      ...approveBody(proposal),
    } as never),
    'task.decide',
  );

/** Starting a run on the ticket as `by` (the decider unless named), at its live revision. */
export const start = async (w: Schedules, ticket: string, by?: Member): Promise<CommandResult> => {
  const body = proposeBody(ticket, await revisionOf(w, ticket), { purpose: freshPurpose() });
  return by === undefined
    ? await asPerson(w, body)
    : await executeCommand(w.db.app, w.business, by.presented, 'api', body as never);
};

/** One research run on the ticket, started, approved, picked up by the agent. */
export const runOn = async (
  w: Schedules,
  ticket: string,
  by?: Member,
): Promise<{ runId: string; picked: Detail }> => {
  const proposal = appliedDetail(await start(w, ticket, by), 'task.propose');
  const picked = await pickup(w, (await approve(w, proposal))['reservationId']);
  return { runId: String(proposal['runId']), picked };
};

/** The agent hands the run back failed, under its lease. */
export const fail = async (w: Schedules, picked: Detail): Promise<void> => {
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

export const failedRun = async (w: Schedules, ticket: string, by?: Member): Promise<string> => {
  const { runId, picked } = await runOn(w, ticket, by);
  await fail(w, picked);
  return runId;
};

export interface Item {
  readonly recipient: string;
  readonly reason: string;
  readonly factKind: string;
  readonly factId: string;
}

/** Every open item on the ticket, in its business. */
export const itemsOn = async (w: Schedules, ticket: string): Promise<Item[]> => [
  ...(await w.db.admin.execute<Item>(
    `select recipient_person_id as recipient, reason, fact_kind as "factKind", fact_id as "factId"
       from public.inbox_items
      where business_id = $1 and subject_record_id = $2 and work_state = 'open'
      order by raised_at, fact_kind, id`,
    [w.business, ticket],
  )),
];

/** Every open item a person holds in the business, whatever its subject. */
export const itemsOf = async (w: Schedules, person: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      `select count(*)::int as n from public.inbox_items
        where business_id = $1 and recipient_person_id = $2 and work_state = 'open'`,
      [w.business, person],
    )
  )[0]?.n ?? 0;

export interface Said {
  readonly type: string;
  readonly audience: string;
  readonly body: string;
}

/** The comments on the ticket, oldest first. */
export const commentsOn = async (w: Schedules, ticket: string): Promise<Said[]> => [
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

export const runsOn = async (w: Schedules, ticket: string): Promise<number> =>
  (
    await w.db.admin.execute<{ n: number }>(
      'select count(*)::int as n from public.planned_runs where business_id = $1 and task_id = $2',
      [w.business, ticket],
    )
  )[0]?.n ?? 0;

export interface Ask {
  readonly recipient: string;
  readonly state: string;
  readonly closedBy: string | null;
}

/** The map owner's asks on the ticket (items about the ticket itself), oldest first. */
export const asksOn = async (w: Schedules, ticket: string): Promise<Ask[]> => [
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
export const mayRun = async (w: Schedules, member: Member, ticket: string): Promise<void> => {
  await w.db.app.withBusiness(w.business, async (tx) => {
    await grantTo(tx, member, 'write', { kind: 'record', id: ticket }, false, 'run');
  });
};

export const STOPPED: { code: string; names: string[] } = {
  code: 'TRANSITION_NOT_PERMITTED',
  names: ['stopped'],
};
