// SPDX-License-Identifier: AGPL-3.0-only
//
// LA-1's local tick: interface only; the behaviour lands in the next commit.

import type { ModelCallExecutor } from '../../packages/core-commands/src/index.ts';
import type {
  BusinessId,
  Database,
  VerifiedSubject,
} from '../../packages/core-records/src/index.ts';
import type { QueueEntry } from '../../packages/core-runtime/src/index.ts';

export type Environment = Readonly<Record<string, string | undefined>>;

export type Refused = { readonly ok: false; readonly code: 'LOCAL_ONLY'; readonly message: string };

export interface ScheduleTick {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: string;
  readonly workerActorId: string;
  readonly now?: () => Date;
}

export interface Fired {
  readonly activationId: string;
  readonly dueAt: Date;
  readonly occurrenceId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly replayed: boolean;
}

export interface TaskTick {
  readonly environment: Environment;
  readonly database: Database;
  readonly businessId: BusinessId;
  readonly agent: VerifiedSubject;
  readonly executeModelCall: ModelCallExecutor;
  readonly operation: string;
  readonly fieldsFor: (entry: QueueEntry) => readonly unknown[];
}

export interface Ran {
  readonly taskId: string;
  readonly outcome: 'completed' | 'refused';
  readonly reply: string | null;
}

export function slotOf(now: Date, everyMinutes: number): Date {
  return new Date(now.getTime() - (now.getTime() % (everyMinutes * 60_000)));
}

export async function fireSchedules(
  _options: ScheduleTick,
): Promise<{ readonly ok: true; readonly fired: readonly Fired[] } | Refused> {
  return await Promise.resolve({ ok: true, fired: [] });
}

export async function runQueuedTasks(
  _options: TaskTick,
): Promise<{ readonly ok: true; readonly ran: readonly Ran[] } | Refused> {
  return await Promise.resolve({ ok: true, ran: [] });
}
