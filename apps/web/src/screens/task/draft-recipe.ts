// SPDX-License-Identifier: AGPL-3.0-only
import { isOperationId, isUuid } from '../../session/storage-slot.ts';
import { timedMinutes, type TaskDraft } from './task-draft.ts';

export type DraftPart =
  | { readonly kind: 'party'; readonly operationId: string; readonly clientId: string }
  | { readonly kind: 'board'; readonly operationId: string; readonly boardId: string }
  | { readonly kind: 'stage'; readonly operationId: string; readonly stage: string }
  | { readonly kind: 'details'; readonly operationId: string; readonly fields: DraftDetails }
  | { readonly kind: 'category'; readonly operationId: string; readonly category: string }
  | { readonly kind: 'assignment'; readonly operationId: string; readonly assigneeId: string }
  | { readonly kind: 'note'; readonly operationId: string; readonly body: string }
  | {
      readonly kind: 'tag';
      readonly name: string;
      readonly createOperationId: string;
      readonly addOperationId: string;
    }
  | { readonly kind: 'child'; readonly operationId: string; readonly title: string }
  | {
      readonly kind: 'time';
      readonly operationId: string;
      readonly duration: string;
      readonly source: 'typed' | 'timer';
    };
/** What `task.update` writes once the task has its client and project. */
export type DraftDetails = {
  readonly description?: string;
  readonly agent_brief?: string;
  readonly priority?: number;
};
export type DraftBody = {
  readonly fields: {
    readonly title: string;
    readonly due?: string;
    readonly estimated_minutes?: number;
  };
  readonly board: null;
};
export const draftBody = (draft: TaskDraft): DraftBody =>
  Object.freeze({
    fields: Object.freeze({
      title: draft.title.trim(),
      ...(draft.due === null ? {} : { due: draft.due }),
      ...(draft.estimate === null ? {} : { estimated_minutes: draft.estimate }),
    }),
    board: null,
  });

/** Authored operands and real identities are captured once, before any dispatch. */
export function draftRecipe(
  identify: (index: number, tagCreate: boolean) => string,
  draft: TaskDraft,
): readonly DraftPart[] {
  const id = (tagCreate = false): string => identify(parts.length, tagCreate);
  const parts: DraftPart[] = [];
  // The client, then the project: no content is written before the task's scope is set.
  if (draft.clientId !== null)
    parts.push({ kind: 'party', operationId: id(), clientId: draft.clientId });
  if (draft.boardId !== null)
    parts.push({ kind: 'board', operationId: id(), boardId: draft.boardId });
  if (draft.stage !== null) parts.push({ kind: 'stage', operationId: id(), stage: draft.stage });
  const details = detailsOf(draft);
  if (Object.keys(details).length > 0)
    parts.push({ kind: 'details', operationId: id(), fields: details });
  if (draft.category !== null)
    parts.push({ kind: 'category', operationId: id(), category: draft.category });
  if (draft.owner !== null)
    parts.push({ kind: 'assignment', operationId: id(), assigneeId: draft.owner.id });
  if (draft.note.trim() !== '')
    parts.push({ kind: 'note', operationId: id(), body: draft.note.trim() });
  for (const name of draft.tags)
    parts.push({ kind: 'tag', name, createOperationId: id(true), addOperationId: id() });
  for (const title of draft.steps) parts.push({ kind: 'child', operationId: id(), title });
  if (draft.time.trim() !== '')
    parts.push({ kind: 'time', operationId: id(), duration: draft.time.trim(), source: 'typed' });
  const minutes = timedMinutes(draft);
  if (minutes > 0)
    parts.push({
      kind: 'time',
      operationId: id(),
      duration: `${String(minutes)}m`,
      source: 'timer',
    });
  return Object.freeze(parts.map((part) => Object.freeze(part)));
}
function detailsOf(draft: TaskDraft): DraftDetails {
  const description = draft.description.trim();
  const brief = draft.agentBrief.trim();
  return {
    ...(description === '' ? {} : { description }),
    ...(brief === '' ? {} : { agent_brief: brief }),
    ...(draft.priority === null ? {} : { priority: draft.priority }),
  };
}

const DETAIL_LABELS: Readonly<Record<keyof DraftDetails, string>> = {
  description: 'the description',
  agent_brief: 'the agent brief',
  priority: 'the priority',
};

/** A refused client or project stops Create: nothing more is written outside the task's scope. */
export const scopePart = (part: DraftPart): boolean =>
  part.kind === 'party' || part.kind === 'board';

export function partLabel(part: DraftPart): string {
  switch (part.kind) {
    case 'party':
      return 'the client';
    case 'board':
      return 'the project';
    case 'stage':
      return 'the stage';
    case 'details':
      return (Object.keys(part.fields) as (keyof DraftDetails)[])
        .map((key) => DETAIL_LABELS[key])
        .join(', ');
    case 'category':
      return 'the category';
    case 'assignment':
      return 'the owner';
    case 'note':
      return 'the note';
    case 'tag':
      return `the tag ${part.name}`;
    case 'child':
      return `the subtask ${part.title}`;
    case 'time':
      return part.source === 'typed' ? 'the time' : 'the timed time';
  }
}
export const operationIds = (part: DraftPart): readonly string[] =>
  part.kind === 'tag' ? [part.createOperationId, part.addOperationId] : [part.operationId];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
/** Each one-operand part's operand. */
const OPERAND: Readonly<Record<string, string>> = {
  party: 'clientId',
  board: 'boardId',
  stage: 'stage',
  category: 'category',
  assignment: 'assigneeId',
  note: 'body',
  child: 'title',
  time: 'duration',
};
export function draftPart(value: unknown): value is DraftPart {
  if (!record(value)) return false;
  const kind = value['kind'];
  if (kind === 'details')
    return (
      closed(value, ['kind', 'operationId', 'fields']) &&
      isOperationId(value['operationId']) &&
      record(value['fields'])
    );
  if (kind === 'tag')
    return (
      closed(value, ['kind', 'name', 'createOperationId', 'addOperationId']) &&
      text(value['name']) &&
      isOperationId(value['createOperationId']) &&
      isOperationId(value['addOperationId'])
    );
  const operand = typeof kind === 'string' ? (OPERAND[kind] ?? null) : null;
  if (
    operand === null ||
    !closed(value, ['kind', 'operationId', operand, ...(kind === 'time' ? ['source'] : [])]) ||
    !isOperationId(value['operationId']) ||
    !text(value[operand])
  )
    return false;
  if ((kind === 'party' || kind === 'board' || kind === 'assignment') && !isUuid(value[operand]))
    return false;
  return kind !== 'time' || value['source'] === 'typed' || value['source'] === 'timer';
}
export function isDraftBody(value: unknown): value is DraftBody {
  if (
    !closed(value, ['fields', 'board']) ||
    value['board'] !== null ||
    typeof value['fields'] !== 'object' ||
    value['fields'] === null ||
    Array.isArray(value['fields'])
  )
    return false;
  const fields = value['fields'];
  if (!record(fields)) return false;
  return (
    text(fields['title']) &&
    fields['title'] === fields['title'].trim() &&
    Object.keys(fields).every((key) => ['title', 'due', 'estimated_minutes'].includes(key)) &&
    (fields['due'] === undefined || typeof fields['due'] === 'string') &&
    (fields['estimated_minutes'] === undefined ||
      (typeof fields['estimated_minutes'] === 'number' &&
        Number.isFinite(fields['estimated_minutes'])))
  );
}
