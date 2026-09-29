// SPDX-License-Identifier: AGPL-3.0-only
//
// The time entry store (MP-4-6).

import type { TenantQuery } from '../tenancy/database.ts';

export interface TimeEntry {
  readonly id: string;
  readonly personId: string;
  readonly personName: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number | null;
  readonly note: string;
  readonly adHoc: boolean;
  readonly source: 'timer' | 'log';
}

export interface TaskTime {
  readonly entries: readonly TimeEntry[];
  readonly running: { readonly entryId: string; readonly startedAt: string } | null;
  readonly totalMinutes: number;
}

interface Person {
  readonly personId: string;
  readonly actorId: string;
}

export function parseDuration(_text: string): number | undefined {
  return undefined;
}

export async function startTimer(
  _tx: TenantQuery,
  _input: Person & { readonly taskId: string },
): Promise<
  | { readonly kind: 'started'; readonly entryId: string; readonly startedAt: string }
  | { readonly kind: 'running' }
  | { readonly kind: 'no-task' }
> {
  return await Promise.resolve({ kind: 'no-task' });
}

export async function stopTimer(
  _tx: TenantQuery,
  _input: Person & { readonly taskId: string },
): Promise<
  | { readonly kind: 'stopped'; readonly entryId: string; readonly minutes: number }
  | { readonly kind: 'none' }
> {
  return await Promise.resolve({ kind: 'none' });
}

export async function logTime(
  _tx: TenantQuery,
  _input: Person & { readonly taskId: string; readonly minutes: number; readonly note: string },
): Promise<{ readonly kind: 'logged'; readonly entryId: string } | { readonly kind: 'no-task' }> {
  return await Promise.resolve({ kind: 'no-task' });
}

export async function setTimeEntryNote(
  _tx: TenantQuery,
  _input: Person & { readonly entryId: string; readonly note: string },
): Promise<boolean> {
  return await Promise.resolve(false);
}

export async function deleteTimeEntry(
  _tx: TenantQuery,
  _input: Person & { readonly entryId: string },
): Promise<'deleted' | 'running' | 'absent'> {
  return await Promise.resolve('absent');
}

export async function readTaskTime(
  _tx: TenantQuery,
  _taskId: string,
  _readerPersonId: string,
): Promise<TaskTime> {
  return await Promise.resolve({ entries: [], running: null, totalMinutes: 0 });
}
