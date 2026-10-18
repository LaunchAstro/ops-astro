// SPDX-License-Identifier: AGPL-3.0-only
// The timer's state and its custody contract, apart from both, so that the
// timer and its custody each import them and not each other.
import type { SearchHit, TaskTimeView } from '../../../../../packages/core-wire/src/index.ts';

export type TimerTask = Pick<SearchHit, 'id'> & Partial<Pick<SearchHit, 'key' | 'title'>>;
export interface TimerBinding {
  readonly task: TimerTask;
  readonly running: TaskTimeView['running'];
}
export type TimerHold = Pick<TimerState, 'binding' | 'attempt'>;
export type TimerDurability = 'none' | 'kept' | 'memory-only';
export interface TimerCustody {
  readonly restored: TimerHold | null;
  /** Tab storage: a failed write can leave a copy behind. */
  readonly durable: boolean;
  readonly write: (hold: TimerHold) => TimerDurability;
}
export interface Attempt {
  readonly command: 'time.start' | 'time.stop';
  readonly task: TimerTask;
  readonly payload: Readonly<{ taskId: string; expectedEntryId?: string }>;
  readonly operationId: string;
  readonly status: 'pending' | 'unknown' | 'refused' | 'abandoned';
  readonly because: string | null;
  readonly uncertain: boolean;
  readonly refusal?: boolean;
  readonly entryId: string | null;
}
export interface TimerState {
  readonly binding: TimerBinding | null;
  readonly attempt: Attempt | null;
  readonly changed: number;
  readonly unavailable: boolean;
  readonly durability: TimerDurability;
}
