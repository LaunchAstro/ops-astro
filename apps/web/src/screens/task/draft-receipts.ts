// SPDX-License-Identifier: AGPL-3.0-only
import { closed } from './draft-recipe.ts';
import type { Settlement } from '../../records/use-command.ts';
import { isUuid } from '../../session/storage-slot.ts';
export type DraftCommandName =
  | 'task.create'
  | 'task.set_party'
  | 'task.move'
  | 'task.set_stage'
  | 'task.update'
  | 'task.set_category'
  | 'task.assign'
  | 'task.comment'
  | 'tag.create'
  | 'task.add_tag'
  | 'time.log';
export interface DraftCommand {
  readonly command: DraftCommandName;
  readonly operationId: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly expectedRevision: number | null;
}
export interface DraftReceipt {
  readonly recordId: string | null;
  readonly revision: number | null;
  readonly key: string | null;
  readonly identifier: string | null;
  readonly minutes: number | null;
}
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function receiptOf(value: unknown, current: DraftCommand): DraftReceipt | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('recordId' in value) ||
    !('revision' in value) ||
    !('detail' in value) ||
    typeof value.detail !== 'object' ||
    value.detail === null ||
    Array.isArray(value.detail)
  )
    return null;
  const detail = value.detail;
  const identifierKey =
    current.command === 'time.log'
      ? 'entryId'
      : current.command === 'task.comment'
        ? 'commentId'
        : current.command === 'tag.create' || current.command === 'task.add_tag'
          ? 'tagId'
          : null;
  if (['tagId', 'entryId', 'commentId'].some((key) => key in detail && key !== identifierKey))
    return null;
  const identifier = identifierKey === null ? null : Reflect.get(detail, identifierKey);
  if (identifier !== null && identifier !== undefined && typeof identifier !== 'string')
    return null;
  if (
    'key' in detail &&
    detail.key !== undefined &&
    detail.key !== null &&
    typeof detail.key !== 'string'
  )
    return null;
  const receipt: DraftReceipt = {
    recordId: typeof value.recordId === 'string' ? value.recordId : null,
    revision: typeof value.revision === 'number' ? value.revision : null,
    key: 'key' in detail && typeof detail.key === 'string' ? detail.key : null,
    identifier: typeof identifier === 'string' ? identifier : null,
    minutes: 'minutes' in detail && typeof detail.minutes === 'number' ? detail.minutes : null,
  };
  if (
    (value.recordId !== null && receipt.recordId === null) ||
    (value.revision !== null && receipt.revision === null)
  )
    return null;
  return receipt;
}
export function validReceipt(
  receipt: DraftReceipt,
  current: DraftCommand,
  parent: DraftReceipt | null,
): boolean {
  const { recordId, revision, identifier, key, minutes } = receipt;
  if (current.command === 'task.create')
    return (
      isUuid(recordId) &&
      positive(revision) &&
      (key === null || key.trim() !== '') &&
      identifier === null &&
      minutes === null &&
      (parent === null || recordId !== parent.recordId)
    );
  if (current.command === 'tag.create')
    return (
      recordId === null &&
      revision === null &&
      isUuid(identifier) &&
      key === null &&
      minutes === null
    );
  if (current.command === 'time.log')
    return (
      recordId === null &&
      revision === null &&
      isUuid(identifier) &&
      key === null &&
      typeof minutes === 'number' &&
      Number.isSafeInteger(minutes) &&
      minutes > 0 &&
      minutes <= 1440
    );
  if (recordId !== parent?.recordId || key !== null || minutes !== null) return false;
  if (current.command === 'task.add_tag')
    return revision === null && identifier === current.body['tagId'] && isUuid(identifier);
  if (current.command === 'task.comment')
    return revision === current.expectedRevision && isUuid(identifier);
  return positive(revision) && identifier === null;
}

export interface DraftAnswer {
  readonly receipt: DraftReceipt | null;
  readonly refusal: string | null;
}
function receiptShape(value: unknown): value is DraftReceipt {
  return (
    closed(value, ['recordId', 'revision', 'key', 'identifier', 'minutes']) &&
    (value['recordId'] === null || typeof value['recordId'] === 'string') &&
    (value['revision'] === null || typeof value['revision'] === 'number') &&
    (value['key'] === null || typeof value['key'] === 'string') &&
    (value['identifier'] === null || typeof value['identifier'] === 'string') &&
    (value['minutes'] === null || typeof value['minutes'] === 'number')
  );
}
export function validAnswer(
  value: unknown,
  current: DraftCommand,
  parent: DraftReceipt | null,
): value is DraftAnswer {
  if (!closed(value, ['receipt', 'refusal'])) return false;
  if (value['receipt'] === null)
    return typeof value['refusal'] === 'string' && value['refusal'] !== '';
  return (
    value['refusal'] === null &&
    receiptShape(value['receipt']) &&
    validReceipt(value['receipt'], current, parent)
  );
}

/** One known-answer boundary for the current writer and the stored recipe codec. */
export function commandAnswer(
  answer: Settlement,
  current: DraftCommand,
  parent: DraftReceipt | null,
): DraftAnswer | null {
  if (answer.kind === 'unknown') return null;
  const value =
    answer.kind === 'ok'
      ? { receipt: receiptOf(answer.value, current), refusal: null }
      : { receipt: null, refusal: answer.refusal.code };
  return validAnswer(value, current, parent) ? value : null;
}
