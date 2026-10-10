// SPDX-License-Identifier: AGPL-3.0-only
// Pure calculations only. useSettings retains every ref, owner effect and settlement.
import type { ReadState } from '../../data/authorised-read.ts';
import type { Tag } from '../../data/owned.ts';
import type { MutationOptions, CommandOutcome } from '../../operations/client.ts';
import type { Settlement, Failure } from '../../records/use-command.ts';
import type { StepUpAsk } from '../../records/use-money-command.ts';
import {
  priorityStageIds,
  type CapabilitiesResult,
  type SettingsReadResult,
  type SettingView,
} from '../../../../../packages/core-wire/src/index.ts';
import { GRANT, holds } from './reads.ts';
import type { Which } from './confirmed.ts';

export interface PriorityIntent {
  readonly tag: Tag;
  readonly value: readonly string[];
  readonly expectedRevision: number;
  readonly operationId: string;
  readonly phase: 'sending' | 'unknown' | 'retrying';
}

export function revision(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export function envelope(
  tag: Tag,
  value: readonly string[],
  expectedRevision: number,
  id: string,
): PriorityIntent {
  return Object.freeze({
    tag,
    value: Object.freeze([...value]),
    expectedRevision,
    operationId: id,
    phase: 'sending',
  });
}

export function mutationOptions(id: string, seen: number | undefined): MutationOptions {
  return seen === undefined ? { operationId: id } : { operationId: id, expectedRevision: seen };
}

export function request(
  intent: PriorityIntent,
): readonly [{ readonly value: readonly string[] }, MutationOptions] {
  return [
    { value: intent.value },
    { operationId: intent.operationId, expectedRevision: intent.expectedRevision },
  ];
}

/** Current authority may withhold stored success; it does not discharge uncertainty. */
export function remainsUnknown(
  intent: PriorityIntent,
  settlement: Settlement<CommandOutcome>,
): boolean {
  return (
    settlement.kind === 'unknown' ||
    (intent.phase !== 'sending' && settlement.kind !== 'ok' && settlement.kind !== 'stale')
  );
}

export function canEdit(
  read: ReadState<SettingsReadResult>,
  row: SettingView | null,
  grantKey: string,
  may: boolean,
  closed: boolean,
): boolean {
  return (
    read.grantKey === grantKey &&
    read.outcome === 'ready' &&
    row?.valueType === 'stage_ids' &&
    revision(row.revision) !== null &&
    priorityStageIds(row.value) !== undefined &&
    may &&
    !closed
  );
}

/** Legacy unavailable caps retain their original fallback; new priority needs admission. */
export function mayFor(
  caps: ReadState<CapabilitiesResult>,
  grantKey: string,
  which: Which,
): boolean {
  return which === 'priority'
    ? caps.grantKey === grantKey &&
        (caps.outcome === 'ready' || caps.outcome === 'empty') &&
        holds(caps.value.grants, GRANT.priority)
    : caps.outcome === 'unavailable'
      ? true
      : caps.outcome === 'ready' || caps.outcome === 'empty'
        ? holds(caps.value.grants, GRANT[which])
        : false;
}

/** A money step-up's fix is drawn only where no prompt can be met. */
export function reason(
  prompt: StepUpAsk | null,
  failure: Failure | null,
  complaint: string | null,
): string | null {
  const stepUp =
    prompt === null && failure?.kind === 'failed' && failure.refusal.code === 'STEP_UP_REQUIRED'
      ? failure.refusal.fixes.join(' ')
      : null;
  return complaint ?? stepUp ?? failure?.because ?? null;
}
