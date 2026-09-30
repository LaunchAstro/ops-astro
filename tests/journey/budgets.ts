// SPDX-License-Identifier: AGPL-3.0-only
//
// T4d (T4-R6): the budgets of specification 10.2, measured and printed with a
// pass or fail beside each, never re-set. Each timed operation is a p95 over
// 100 runs through the served API on loopback, against the journey's world
// (two businesses, a handful of people), not section 10.1's fixture: every
// line says what it was measured against, so a pass here is not a claim about
// the fixture's scale. The `task.pickup` payload is measured against its
// 256 KB cap. Pickup and hand-back are timed on the real agent routes: a
// provider that drops makes the worker hand back after its pickup (T3e1).

import { randomUUID } from 'node:crypto';
import { availableParallelism, loadavg } from 'node:os';
import { httpTransport, type Transport } from '../../apps/cli/client.ts';
import { ProviderFault } from '../../apps/worker/usage.ts';
import { approvedTask, personOn, revokePickup, type PassContext, type Person } from './passes.ts';

export interface Budget {
  readonly operation: string;
  readonly budget: string;
  readonly measured: string;
  readonly status: 'pass' | 'fail' | 'unrun';
  readonly against: string;
  /** The machine's load while it was measured, so load can be told from a regression. */
  readonly load: string;
}

export const RUNS = 100;

/**
 * The 1-minute load average when a measurement began and when it ended,
 * beside the CPU count (Sol, review 1 on #164): lanes share this machine.
 */
function loadSince(start: number): string {
  const end = loadavg()[0] ?? 0;
  return `1-min load ${start.toFixed(2)} at start, ${end.toFixed(2)} at end, ${String(availableParallelism())} CPUs`;
}
const PAYLOAD_CAP = 256 * 1024;
const WORLD = `the journey's world, p95 over ${String(RUNS)} runs through the served API`;

function p95(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

function line(
  operation: string,
  budgetMs: number,
  samples: readonly number[],
  load: string,
): Budget {
  const measured = p95(samples);
  return {
    operation,
    budget: `${String(budgetMs)} ms`,
    measured: `${measured.toFixed(1)} ms (n ${String(samples.length)})`,
    status: samples.length === RUNS && measured <= budgetMs ? 'pass' : 'fail',
    against: WORLD,
    load,
  };
}

async function timed(run: () => Promise<unknown>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

/** The person's calls, timed one after another, each one required to succeed. */
async function personBudgets(person: Person): Promise<Budget[]> {
  const ok = async (name: Parameters<Person>[0], body: Record<string, unknown>) => {
    const answer = await person(name, body);
    if (answer.outcome !== 'ok') throw new Error(`budget ${name}: ${answer.text.slice(0, 300)}`);
    return answer.body;
  };
  const began = loadavg()[0] ?? 0;
  const samples: Record<string, number[]> = { create: [], update: [], read: [], board: [] };
  const created: string[] = [];
  for (let run = 0; run < RUNS; run += 1) {
    const body = { operationId: randomUUID(), fields: { title: `Budget ${String(run)}` } };
    const create = async () => created.push(String((await ok('task.create', body))['recordId']));
    // eslint-disable-next-line no-await-in-loop -- one timed call at a time
    const ms = await timed(create);
    samples['create']?.push(ms);
  }
  for (const recordId of created) {
    const body = {
      operationId: randomUUID(),
      recordId,
      expectedRevision: 1,
      fields: { title: 'Budget, renamed' },
    };
    // eslint-disable-next-line no-await-in-loop -- one timed call at a time
    samples['update']?.push(await timed(async () => await ok('task.update', body)));
    // eslint-disable-next-line no-await-in-loop -- one timed call at a time
    samples['read']?.push(await timed(async () => await ok('task.read', { recordId })));
    // eslint-disable-next-line no-await-in-loop -- one timed call at a time
    samples['board']?.push(await timed(async () => await ok('task.board', { board: null })));
  }
  const load = loadSince(began);
  return [
    line('Board first page', 150, samples['board'] ?? [], load),
    line('Task detail read', 200, samples['read'] ?? [], load),
    line('task.create', 100, samples['create'] ?? [], load),
    line('task.update with expected_revision', 100, samples['update'] ?? [], load),
  ];
}

/** Pickup, hand-back and the run read, on the real agent routes, with the payload's size. */
async function agentBudgets(context: PassContext, person: Person): Promise<Budget[]> {
  const began = loadavg()[0] ?? 0;
  const timings: Record<string, number[]> = { pickup: [], handback: [], execution: [] };
  let largest = 0;
  const measuring: Transport = async (path, body, bearer, held) => {
    const started = performance.now();
    const response = await httpTransport(context.api)(path, body, bearer, held);
    const text = await response.text();
    const kind = /task\/(pickup|handback)$/u.exec(path)?.[1];
    if (kind !== undefined) timings[kind]?.push(performance.now() - started);
    if (kind === 'pickup') largest = Math.max(largest, Buffer.byteLength(text));
    return new Response(text, { status: response.status, headers: response.headers });
  };
  const withId = async (name: Parameters<Person>[0], body: Record<string, unknown>) =>
    await person(name, { operationId: randomUUID(), ...body });
  // Whatever ran before (the live-update check) may leave its pickup's delegation live.
  await revokePickup(context.world, withId);
  for (let run = 0; run < RUNS; run += 1) {
    // eslint-disable-next-line no-await-in-loop -- each run is its own task, in order
    const taskId = await droppedRun(context, measuring, withId);
    const read = async () => await person('task.execution', { recordId: taskId });
    // eslint-disable-next-line no-await-in-loop -- as above
    const ms = await timed(read);
    timings['execution']?.push(ms);
    // eslint-disable-next-line no-await-in-loop -- the pickup's delegation, ended as the passes end it
    await revokePickup(context.world, withId);
  }
  const load = loadSince(began);
  const payload: Budget = {
    operation: 'task.pickup payload size',
    budget: `${String(PAYLOAD_CAP)} bytes`,
    measured: `${String(largest)} bytes, the largest of ${String(RUNS)}`,
    status: largest > 0 && largest <= PAYLOAD_CAP ? 'pass' : 'fail',
    against:
      "the journey's world: one step, no comments, so the cap's overflow path is not reached here",
    load,
  };
  return [
    line('task.pickup, the whole one-call payload', 300, timings['pickup'] ?? [], load),
    line('task.handback', 300, timings['handback'] ?? [], load),
    line('readTaskExecution first page', 250, timings['execution'] ?? [], load),
    payload,
  ];
}

/** One approved task picked up and handed back dropped, on the measuring transport. */
async function droppedRun(
  context: PassContext,
  measuring: Transport,
  withId: Person,
): Promise<string> {
  const { taskId, worker } = await approvedTask(context, withId, 'Pickup', {
    transport: measuring,
    provider: { call: async () => await Promise.reject(new ProviderFault('provider_unavailable')) },
  });
  const dropped = await worker.applyOnce(taskId);
  if (!('dropped' in dropped)) throw new Error(`budget handback: ${JSON.stringify(dropped)}`);
  return taskId;
}

function unrun(operation: string, budget: string, reason: string): Budget {
  return {
    operation,
    budget,
    measured: 'not measured',
    status: 'unrun',
    against: reason,
    load: 'not measured',
  };
}

/** Every budget in 10.2, measured, carried from elsewhere in the run, or unrun with its reason. */
export async function measureBudgets(
  context: PassContext,
  liveMs: number | undefined,
): Promise<Budget[]> {
  // The app's own client, straight at the API: server-side time, no proxy hop.
  const direct = personOn('app', { ...context, app: context.api }, context.world.ada.token);
  return [
    ...(await personBudgets(direct)),
    ...(await agentBudgets(context, direct)),
    unrun(
      'Comment thread page of 50 on a 500-comment task',
      '200 ms',
      'task.read returns the whole thread at this head; there is no page of 50 to time',
    ),
    {
      operation: 'An event written becoming visible on an open page',
      budget: '2000 ms',
      measured: liveMs === undefined ? 'not measured' : `${String(liveMs)} ms (one run)`,
      status: liveMs === undefined ? 'unrun' : liveMs <= 2000 ? 'pass' : 'fail',
      against:
        'the live-update case of this run, an in-process event-stream client on the web origin',
      load: 'not recorded for the one live-update run',
    },
    unrun(
      'The full six-role, nine-case isolation enumeration',
      '10 minutes',
      'measured in continuous integration, not by a local run',
    ),
  ];
}
