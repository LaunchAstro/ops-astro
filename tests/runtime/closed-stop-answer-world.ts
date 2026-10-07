// SPDX-License-Identifier: AGPL-3.0-only
//
// The steps the closed-stop crossings take (`closed-stop-answer-isolation`):
// two businesses, a stop raised on a closed hold with a call still reserved
// on it, the answers a person or an agent sends, and everything an answer
// could write, read back as the owner reads it.

import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { installBusinessSettings } from '../../packages/core-records/src/records/business-settings.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { topUpAtBudgetStop } from '../../packages/core-runtime/src/index.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import {
  approve,
  asAgent,
  codeOf,
  freshPurpose,
  openSchedules,
  pickup,
  propose,
  rows,
  seedSchedules,
  type Body,
  type Detail,
  type Schedules,
  type Work,
} from './schedules-harness.ts';
import {
  askOf,
  callState,
  expireLease,
  holdsOf,
  roomyWork,
  spend,
  stampBefore,
  stopWorker,
  unsentCall,
} from './version-room-world.ts';

/** A run stopped on its closed first hold, with a call on that hold still reserved. */
export interface Stopped {
  readonly work: Work;
  readonly first: string;
  readonly unsent: string;
  readonly runId: string;
  readonly askId: string;
}

export interface Crossings {
  readonly alpha: Schedules;
  readonly bravo: Schedules;
  /** Alpha's stop the authorised answer applies to. */
  readonly a1: Stopped;
  /** Bravo's stop, which nothing in alpha may reach. */
  readonly b1: Stopped;
  readonly clientA: Stopped;
  readonly clientB: Stopped;
  readonly agentStop: Stopped;
}

/** The decider may top up and end anywhere in its business. */
async function prepare(s: Schedules): Promise<void> {
  await s.db.app.withBusiness(s.business, async (tx) => {
    await grantTo(tx, s.decider, 'manage');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'billing');
    await grantTo(tx, s.decider, 'decide', undefined, false, 'gate');
    await installBusinessSettings(tx);
  });
}

/**
 * The first hold spends 300 and reserves 200 it never sends; its lease ends,
 * the replacement spends the 200 the version has left and its worker is
 * stopped, so picking the first hold up again finds the version full and
 * stops on that closed hold.
 */
export async function stopped(s: Schedules): Promise<Stopped> {
  const { work, first } = await roomyWork(s);
  await spend(s, first, 300);
  const unsent = await unsentCall(s, first, 200);
  await expireLease(s, work.picked);
  const second = await pickup(s, first);
  await spend(s, second['reservationId'], 200);
  await stopWorker(s, second);
  await stampBefore(s, first, second['reservationId']);
  const claimed = await asAgent(s, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: first,
    leaseSeconds: 600,
  });
  const { runId, askId } = await askOf(s, first);
  const hold = (await holdsOf(s, work.proposal['versionId'])).find((h) => h.id === first);
  expect({
    stopped: codeOf(claimed),
    asked: askId !== undefined,
    hold: hold?.state,
    call: await callState(s, unsent),
  }).toEqual({ stopped: 'BUDGET_UNAVAILABLE', asked: true, hold: 'actual', call: 'reserved' });
  return { work, first: String(first), unsent, runId, askId: String(askId) };
}

/** Two businesses on one database, and the five stops the crossings name. */
export async function openCrossings(): Promise<Crossings> {
  const alpha = await openSchedules('closed_stop_iso', 1_000_000);
  const bravo = await seedSchedules(alpha.db, 'closed_stop_iso_b', 1_000_000);
  await prepare(alpha);
  await prepare(bravo);
  return {
    alpha,
    bravo,
    a1: await stopped(alpha),
    b1: await stopped(bravo),
    clientA: await stopped(alpha),
    clientB: await stopped(alpha),
    agentStop: await stopped(alpha),
  };
}

/** Everything an answer could write for a task's runs, read as the owner reads it. */
export async function ledgerOf(s: Schedules, taskId: string): Promise<unknown> {
  const runs = 'select id from public.planned_runs where business_id = $1 and task_id = $2';
  const read = async (text: string): Promise<unknown> => await rows(s, text, [s.business, taskId]);
  return {
    runs: await read(
      'select id, state from public.planned_runs where business_id = $1 and task_id = $2 order by id',
    ),
    calls: await read(
      `select id, state, reserved_minor::text as reserved, actual_minor::text as actual,
              ended_at::text as ended
         from public.model_calls where business_id = $1 and run_id in (${runs}) order by id`,
    ),
    holds: await read(
      `select id, state, held_minor::text as held, actual_minor::text as actual
         from public.reservations where business_id = $1 and run_id in (${runs}) order by id`,
    ),
    asks: await read(
      `select id, ask_number from public.budget_asks
        where business_id = $1 and run_id in (${runs}) order by id`,
    ),
    answers: await read(
      `select id, kind from public.budget_answers
        where business_id = $1 and run_id in (${runs}) order by id`,
    ),
    approvals: await read(
      `select id from public.budget_approvals
        where business_id = $1 and run_id in (${runs}) order by id`,
    ),
    envelope: await read(
      `select maximum_minor::text as maximum, held_minor::text as held,
              actual_minor::text as actual
         from public.task_envelopes where business_id = $1 and task_id = $2`,
    ),
  };
}

export type Route = 'run.top_up' | 'run.end_at_budget_stop';
export const ROUTES: readonly Route[] = ['run.top_up', 'run.end_at_budget_stop'];

export function answerBody(route: Route, recordId: string, runId: string, askId: string): Body {
  return {
    command: route,
    operationId: randomUUID(),
    recordId,
    runId,
    askId,
    ...(route === 'run.top_up' ? { amountMinor: 100, currency: 'AUD' } : {}),
  };
}

/** A person's command, through the entry the HTTP boundary mounts. */
export async function asMember(s: Schedules, who: Member, body: Body): Promise<CommandResult> {
  return await executeCommand(s.db.app, s.business, who.presented, 'api', body as never);
}

/** What the caller is told, less the operation id it sent. */
function bytesOf(result: CommandResult): string {
  const { operationId: _own, ...rest } = result as unknown as Record<string, unknown>;
  return JSON.stringify(rest);
}

/**
 * `who` names `target`'s run and ask under `recordId` on both routes, beside a
 * made-up run and ask under the same task: refused, told the same bytes, and
 * never told the run. The codes, route by route.
 */
export async function sameAsMadeUp(
  s: Schedules,
  who: Member,
  recordId: string,
  target: Stopped,
): Promise<readonly string[]> {
  const codes: string[] = [];
  for (const route of ROUTES) {
    // eslint-disable-next-line no-await-in-loop -- one crossing at a time reads as a list
    const crossed = await asMember(s, who, answerBody(route, recordId, target.runId, target.askId));
    // eslint-disable-next-line no-await-in-loop
    const madeUp = await asMember(s, who, answerBody(route, recordId, randomUUID(), randomUUID()));
    expect(codeOf(crossed), route).not.toBe('applied');
    expect(bytesOf(crossed), route).toBe(bytesOf(madeUp));
    expect(bytesOf(crossed), route).not.toContain(target.runId);
    codes.push(codeOf(crossed));
  }
  return codes;
}

/** `who` answers `target` on both routes under its own task; the codes. */
export async function answerCodes(
  s: Schedules,
  who: Member,
  target: Stopped,
  askId: string = target.askId,
): Promise<readonly string[]> {
  const codes: string[] = [];
  for (const route of ROUTES) {
    // eslint-disable-next-line no-await-in-loop -- one route at a time reads as a list
    const answer = await asMember(
      s,
      who,
      answerBody(route, target.work.taskId, target.runId, askId),
    );
    codes.push(codeOf(answer));
  }
  return codes;
}

/** Link the task to a client the way `task.set_party` stores it; the slot read back. */
export async function linkClient(s: Schedules, taskId: string): Promise<string | null> {
  await s.db.admin.execute(
    `update public.records set data = data || jsonb_build_object('client', $2::text)
      where business_id = $1 and id = $3`,
    [s.business, randomUUID(), taskId],
  );
  const [linked] = await rows<{ client: string | null }>(
    s,
    'select uuid_7::text as client from public.records where business_id = $1 and id = $2',
    [s.business, taskId],
  );
  return linked?.client ?? null;
}

/** A member granted `decide` on billing and gate on `taskId` alone, or on nothing. */
export async function memberOn(s: Schedules, name: string, taskId: string | null): Promise<Member> {
  const member = await enrol(s.db.app, s.business, name);
  if (taskId === null) return member;
  await s.db.app.withBusiness(s.business, async (tx) => {
    const scope = { kind: 'record', id: taskId } as const;
    await grantTo(tx, member, 'decide', scope, false, 'billing');
    await grantTo(tx, member, 'decide', scope, false, 'gate');
  });
  return member;
}

/**
 * A second piece of work on the same task, within the envelope's room, picked
 * up: the agent's live delegation, bounded to this task.
 */
export async function delegationOn(s: Schedules, taskId: string): Promise<Detail> {
  const proposal = await propose(s, taskId, { purpose: freshPurpose(), maximumMinor: 100 });
  const live = await pickup(s, (await approve(s, proposal))['reservationId']);
  const [covers] = await rows<{ scope: string }>(
    s,
    'select purpose_scope_id::text as scope from public.delegations where id = $1',
    [live['delegationId']],
  );
  expect(covers?.scope).toBe(taskId);
  return live;
}

/** The agent's answers on both routes under `credential`, and its top-up at the runtime. */
export async function agentAnswers(
  s: Schedules,
  target: Stopped,
  credential: string,
): Promise<{ readonly commands: readonly string[]; readonly runtime: string }> {
  const commands: string[] = [];
  for (const route of ROUTES) {
    const body = answerBody(route, target.work.taskId, target.runId, target.askId);
    // eslint-disable-next-line no-await-in-loop -- one route at a time reads as a list
    commands.push(codeOf(await asAgent(s, body, credential)));
  }
  const runtime = await s.db.app.withBusiness(
    s.business,
    async (tx) =>
      await topUpAtBudgetStop(tx, {
        runId: target.runId,
        askId: target.askId,
        caller: { kind: 'agent', actorId: s.agentActorId },
        subjects: [{ kind: 'actor', id: s.agentActorId }],
        amountMinor: 100,
        currency: 'AUD',
      }),
  );
  return { commands, runtime: runtime.ok ? 'applied' : runtime.refusal.code };
}
