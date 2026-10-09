// SPDX-License-Identifier: AGPL-3.0-only
import { TASK_STAGES } from '../../../../../packages/core-wire/src/index.ts';
import { isUuid } from '../../session/storage-slot.ts';
// Same identity boundary as core-commands/commands/requests.ts and register-store.ts.
export const operationId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/u.test(value);
export const BOARD_EDIT_KEY = 'ops-astro.board-edit-attempts';
export type BoardEditIntent =
  | {
      readonly command: 'task.update';
      readonly body: {
        readonly recordId: string;
        readonly fields:
          | { readonly title: string }
          | { readonly due: string | null }
          | { readonly estimated_minutes: number | null };
      };
    }
  | {
      readonly command: 'task.set_stage';
      readonly body: { readonly recordId: string; readonly fields: { readonly stage: string } };
    }
  | { readonly command: 'task.complete'; readonly body: { readonly recordId: string } }
  | {
      readonly command: 'task.reopen';
      readonly body: { readonly recordId: string; readonly reason: string };
    };
export type BoardEditAttempt = BoardEditIntent & {
  readonly operationId: string;
  readonly expectedRevision: number;
};
export interface BoardEditEntry {
  readonly attempt: BoardEditAttempt;
  readonly knowledge: 'prepared' | 'unresolved' | 'answered';
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const keys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).length === allowed.length && allowed.every((key) => Object.hasOwn(value, key));
export const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
function fields(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 1) return false;
  if (Object.hasOwn(value, 'title'))
    return (
      typeof value['title'] === 'string' &&
      value['title'].trim() !== '' &&
      value['title'] === value['title'].trim()
    );
  if (Object.hasOwn(value, 'estimated_minutes'))
    return (
      value['estimated_minutes'] === null ||
      (typeof value['estimated_minutes'] === 'number' &&
        Number.isSafeInteger(value['estimated_minutes']) &&
        value['estimated_minutes'] >= 0)
    );
  const due = value['due'];
  return (
    Object.hasOwn(value, 'due') &&
    (due === null ||
      (typeof due === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/u.test(due) &&
        !Number.isNaN(Date.parse(due)) &&
        new Date(due).toISOString().slice(0, 10) === due))
  );
}
function attempt(value: unknown, id: string): value is BoardEditAttempt {
  if (
    !record(value) ||
    !keys(value, ['command', 'body', 'operationId', 'expectedRevision']) ||
    !operationId(value['operationId']) ||
    !revision(value['expectedRevision']) ||
    !record(value['body']) ||
    value['body']['recordId'] !== id
  )
    return false;
  const body = value['body'];
  const stageId = record(body['fields']) ? body['fields']['stage'] : null;
  switch (value['command']) {
    case 'task.complete':
      return keys(body, ['recordId']);
    case 'task.reopen':
      return (
        keys(body, ['recordId', 'reason']) && body['reason'] === 'Reopened from the Projects board'
      );
    case 'task.update':
      return keys(body, ['recordId', 'fields']) && fields(body['fields']);
    case 'task.set_stage':
      return (
        keys(body, ['recordId', 'fields']) &&
        record(body['fields']) &&
        keys(body['fields'], ['stage']) &&
        TASK_STAGES.list().some((stage) => stage.id === stageId)
      );
    default:
      return false;
  }
}
export function boardEditDocument(
  value: unknown,
  owner: string,
): ReadonlyMap<string, BoardEditEntry> | null {
  if (
    !record(value) ||
    !keys(value, ['version', 'owner', 'tasks']) ||
    value['version'] !== 1 ||
    value['owner'] !== owner ||
    !record(value['tasks'])
  )
    return null;
  const entries = new Map<string, BoardEditEntry>();
  const operations = new Set<string>();
  for (const [id, entry] of Object.entries(value['tasks'])) {
    if (
      !isUuid(id) ||
      !record(entry) ||
      !keys(entry, ['attempt', 'knowledge']) ||
      !attempt(entry['attempt'], id) ||
      (entry['knowledge'] !== 'unresolved' && entry['knowledge'] !== 'answered') ||
      operations.has(entry['attempt'].operationId)
    )
      return null;
    operations.add(entry['attempt'].operationId);
    entries.set(id, { attempt: entry['attempt'], knowledge: entry['knowledge'] });
  }
  return entries;
}
export function boardEditReceipt(value: unknown, id: string): boolean {
  return (
    record(value) &&
    value['recordId'] === id &&
    revision(value['revision']) &&
    record(value['detail'])
  );
}
