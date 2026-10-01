// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's local tick (#859): the owner's laptop drives scheduled jobs and a
// task's agent run with no hosted worker. Nothing here is new product logic;
// each step is the product's own:
//
// - A scheduled job. For each enabled schedule of the business, the due slot
//   (the start of the current `everyMinutes` window) is claimed through C33's
//   `claimOccurrence`, which writes it once, and an approved occurrence is
//   dispatched through C52-A's `dispatchOccurrence` with the product's run
//   starter, which starts the run and its task (AW-01 J). A second tick in the
//   same slot replays and starts nothing. An occurrence's run has no model
//   step yet: no reservation can name it, and AW-04 builds its claim
//   (docs/local/RUNTIME.md, "An automation occurrence's run").
// - A task's agent run. Approved work in the queue is picked up by the agent
//   through the production agent entry (`task.pickup`), its one model step
//   goes through the broker's executor (`model.call`, the server's own
//   wiring), and the run is handed back completed (`task.handback`). The
//   model's words are returned to the caller once and never stored: the
//   handback's report says only that the step answered.
//
// Both refuse unless OPS_ENVIRONMENT is exactly `local`, before any read or
// write. Each works in the one business it is given, through that business's
// own transactions, so another business's schedules and work are never read.

import { randomUUID } from 'node:crypto';
import {
  executeAgentCommand,
  isCommandRefusal,
  occurrenceRunStarter,
  type ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';
import {
  claimOccurrence,
  dispatchOccurrence,
  listRegistry,
  type BusinessId,
  type Database,
  type VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import { queue, type QueueEntry } from '../../packages/core-runtime/src/index.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export interface Refused {
  readonly ok: false;
  readonly code: 'LOCAL_ONLY';
  readonly message: string;
}

/** Undefined on the owner's laptop; otherwise the refusal, before anything is read. */
export function localOnly(environment: Environment): Refused | undefined {
  if (environment['OPS_ENVIRONMENT'] === 'local') return undefined;
  return {
    ok: false,
    code: 'LOCAL_ONLY',
    message:
      'The local tick runs only with OPS_ENVIRONMENT=local, on the laptop, on made-up data. ' +
      'Staging, hosted and production run their jobs through the API provider.',
  };
}

/** The start of the `everyMinutes` window `now` falls in: the occurrence's due time. */
export function slotOf(now: Date, everyMinutes: number): Date {
  const width = everyMinutes * 60_000;
  return new Date(now.getTime() - (now.getTime() % width));
}

export interface ScheduleTick {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: BusinessId;
  /** The business's active worker, who starts an occurrence's run (AW-01 J). */
  readonly workerActorId: string;
  readonly now?: () => Date;
}

export interface Fired {
  readonly activationId: string;
  readonly dueAt: Date;
  readonly occurrenceId: string;
  /** Null when the occurrence started no run: not approved, refused, or waiting on the ceiling. */
  readonly runId: string | null;
  readonly taskId: string | null;
  /** The slot was claimed by an earlier tick. */
  readonly replayed: boolean;
}

/** One dispatch of an approved occurrence: its run and the run's task, or none. */
async function dispatched(
  options: ScheduleTick,
  occurrenceId: string,
): Promise<{ readonly runId: string | null; readonly taskId: string | null }> {
  return await options.database.withBusiness(options.businessId, async (tx) => {
    const dispatch = await dispatchOccurrence(
      tx,
      occurrenceId,
      occurrenceRunStarter(options.workerActorId),
    );
    const isRun = dispatch.kind === 'dispatched' || dispatch.kind === 'replayed';
    const runId = isRun ? dispatch.dispatch.runId : null;
    if (runId === null) return { runId: null, taskId: null };
    const [run] = await tx.query<{ readonly task_id: string }>(
      'select task_id from public.planned_runs where id = $1',
      [runId],
    );
    return { runId, taskId: run?.task_id ?? null };
  });
}

/** One pass over the business's schedules: each due slot claimed once and dispatched. */
export async function fireSchedules(
  options: ScheduleTick,
): Promise<{ readonly ok: true; readonly fired: readonly Fired[] } | Refused> {
  const refused = localOnly(options.environment);
  if (refused !== undefined) return refused;
  const now = (options.now ?? ((): Date => new Date()))();
  const { database, businessId } = options;
  const registry = await database.withBusiness(businessId, async (tx) => await listRegistry(tx));
  const fired: Fired[] = [];
  for (const activation of registry.activations) {
    if (activation.mode !== 'scheduled' || !activation.enabled) continue;
    if (activation.everyMinutes === null) continue;
    const dueAt = slotOf(now, activation.everyMinutes);
    // Sequential: each claim holds the activation's and the business's locks to commit.
    // eslint-disable-next-line no-await-in-loop
    const claim = await database.withBusiness(
      businessId,
      async (tx) => await claimOccurrence(tx, activation.id, { dueAt }),
    );
    if (claim.kind !== 'claimed' && claim.kind !== 'replayed') continue;
    const { occurrence } = claim;
    const run =
      occurrence.outcome === 'approved'
        ? // eslint-disable-next-line no-await-in-loop
          await dispatched(options, occurrence.id)
        : { runId: null, taskId: null };
    fired.push({
      activationId: activation.id,
      dueAt,
      occurrenceId: occurrence.id,
      ...run,
      replayed: claim.kind === 'replayed',
    });
  }
  return { ok: true, fired };
}

export interface TaskTick {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: BusinessId;
  /** The agent's own login; the delegation each pickup mints is its authority for that work. */
  readonly agent: VerifiedSubject;
  /** The broker's `model.call` executor, as the server mounts it. */
  readonly executeModelCall: ModelCallExecutor;
  /** The catalogued model operation the step calls: replay in tests, `local-claude` on the laptop. */
  readonly operation: string;
  /** The step's fields for this work, each bound to a row or stated with its source (S3). */
  readonly fieldsFor: (entry: QueueEntry) => readonly unknown[];
  readonly leaseSeconds?: number;
}

export interface Ran {
  readonly taskId: string;
  readonly outcome: 'completed' | 'refused';
  /** The model's words, handed back once and never stored; null when no answer came. */
  readonly reply: string | null;
  /** The step that refused and its code, when one did. */
  readonly refusal: { readonly step: string; readonly code: string } | null;
}

const refusedAt = (entry: QueueEntry, step: string, code: string): Ran => ({
  taskId: entry.taskId,
  outcome: 'refused',
  reply: null,
  refusal: { step, code },
});

/** Pick one piece of queued work up, make its model step, hand it back completed. */
async function runOne(options: TaskTick, entry: QueueEntry): Promise<Ran> {
  const { database, businessId, agent } = options;
  const picked = await executeAgentCommand(database, businessId, agent, undefined, {
    command: 'task.pickup',
    operationId: randomUUID(),
    reservationId: entry.reservationId,
    leaseSeconds: options.leaseSeconds ?? 600,
  } as never);
  if (isCommandRefusal(picked)) return refusedAt(entry, 'task.pickup', picked.code);
  const { leaseId, fence } = picked.detail;
  const credential = String(picked.detail['credential']);
  const call = await options.executeModelCall(database, businessId, agent, credential, {
    command: 'model.call',
    operationId: randomUUID(),
    leaseId,
    fence,
    operation: options.operation,
    fields: options.fieldsFor(entry),
  } as never);
  if (isCommandRefusal(call)) return refusedAt(entry, 'model.call', call.code);
  const text = call.detail['text'];
  const reply = typeof text === 'string' ? text : null;
  const handedBack = await executeAgentCommand(database, businessId, agent, credential, {
    command: 'task.handback',
    operationId: randomUUID(),
    leaseId,
    fence,
    outcome: 'completed',
    report: {
      summary: reply === null ? 'the model step gave no answer' : 'the model step answered',
    },
    actualMinor: null,
  } as never);
  if (isCommandRefusal(handedBack)) return refusedAt(entry, 'task.handback', handedBack.code);
  return { taskId: entry.taskId, outcome: 'completed', reply, refusal: null };
}

/** One pass over the business's queue: each approved piece of work run once, in order. */
export async function runQueuedTasks(
  options: TaskTick,
): Promise<{ readonly ok: true; readonly ran: readonly Ran[] } | Refused> {
  const refused = localOnly(options.environment);
  if (refused !== undefined) return refused;
  const entries = await options.database.withBusiness(
    options.businessId,
    async (tx) => await queue(tx),
  );
  const ran: Ran[] = [];
  for (const entry of entries) {
    // Sequential: one model call at a time on the owner's own seat.
    // eslint-disable-next-line no-await-in-loop
    ran.push(await runOne(options, entry));
  }
  return { ok: true, ran };
}

export type TickOptions = ScheduleTick & TaskTick;

export type Tick =
  | {
      readonly ok: true;
      readonly fired: readonly Fired[];
      readonly ran: readonly Ran[];
    }
  | Refused;

/** One whole pass: schedules first, so a run they start is in the queue the task pass reads. */
export async function tick(options: TickOptions): Promise<Tick> {
  const fired = await fireSchedules(options);
  if (!fired.ok) return fired;
  const ran = await runQueuedTasks(options);
  if (!ran.ok) return ran;
  return { ok: true, fired: fired.fired, ran: ran.ran };
}

/**
 * The long-lived process's clock: one pass now, then one every `intervalMs`,
 * never two at once (a pass still running when the next is due skips it).
 * Refuses outside local before the first pass; `stop` waits for a running one.
 */
export function startTicking(
  options: TickOptions,
  intervalMs: number,
  report: (pass: Tick | { readonly ok: false; readonly error: unknown }) => void = () => {},
): Refused | { readonly stop: () => Promise<void> } {
  const refused = localOnly(options.environment);
  if (refused !== undefined) return refused;
  let running: Promise<void> | undefined;
  const pass = (): void => {
    if (running !== undefined) return;
    running = tick(options)
      .then(report, (error: unknown) => report({ ok: false, error }))
      .finally(() => {
        running = undefined;
      });
  };
  pass();
  const timer = setInterval(pass, intervalMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
