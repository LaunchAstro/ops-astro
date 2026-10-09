// SPDX-License-Identifier: AGPL-3.0-only
import { isUuid } from '../../session/storage-slot.ts';

export const CREATE_KEY = 'ops-astro.create-attempts';
export interface CreateEditor {
  readonly id: string;
  readonly generation: number;
}
export interface CreateReceipt {
  readonly recordId: string;
  readonly revision: number;
  readonly key: string | null;
}
export type CreateKnowledge =
  | { readonly kind: 'prepared' | 'unresolved' }
  | {
      readonly kind: 'answered';
      readonly receipt: CreateReceipt | null;
      readonly refusal: string | null;
    };
export interface CreateAttempt {
  readonly origin: 'inline';
  readonly operationId: string;
  readonly editor: CreateEditor;
  readonly body: { readonly fields: { readonly title: string }; readonly board: null };
  readonly knowledge: CreateKnowledge;
}
interface CreateDocument {
  readonly version: 1;
  readonly owner: string;
  readonly entries: Readonly<Record<string, CreateAttempt>>;
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return (
    Object.keys(value).length === allowed.length &&
    allowed.every((key) => Object.hasOwn(value, key))
  );
}
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function receipt(value: unknown): value is CreateReceipt {
  return (
    record(value) &&
    keys(value, ['recordId', 'revision', 'key']) &&
    isUuid(value['recordId']) &&
    count(value['revision']) &&
    value['revision'] > 0 &&
    (value['key'] === null || (typeof value['key'] === 'string' && value['key'].trim() !== ''))
  );
}
function knowledge(value: unknown): value is CreateKnowledge {
  if (!record(value)) return false;
  if (value['kind'] === 'unresolved') return keys(value, ['kind']);
  return (
    value['kind'] === 'answered' &&
    keys(value, ['kind', 'receipt', 'refusal']) &&
    (value['receipt'] === null
      ? typeof value['refusal'] === 'string' && value['refusal'] !== ''
      : receipt(value['receipt']) && value['refusal'] === null)
  );
}
function attempt(value: unknown): value is CreateAttempt {
  if (
    !record(value) ||
    !keys(value, ['origin', 'operationId', 'editor', 'body', 'knowledge']) ||
    value['origin'] !== 'inline' ||
    !isUuid(value['operationId']) ||
    !record(value['editor']) ||
    !keys(value['editor'], ['id', 'generation']) ||
    !isUuid(value['editor']['id']) ||
    !count(value['editor']['generation']) ||
    !record(value['body']) ||
    !keys(value['body'], ['fields', 'board']) ||
    value['body']['board'] !== null ||
    !record(value['body']['fields']) ||
    !keys(value['body']['fields'], ['title'])
  )
    return false;
  const title = value['body']['fields']['title'];
  return (
    typeof title === 'string' &&
    title.trim() !== '' &&
    title === title.trim() &&
    knowledge(value['knowledge'])
  );
}
export function createDocument(value: unknown, owner: string): CreateDocument | null {
  if (
    !record(value) ||
    !keys(value, ['version', 'owner', 'entries']) ||
    value['version'] !== 1 ||
    value['owner'] !== owner ||
    !record(value['entries'])
  )
    return null;
  const entries = value['entries'];
  const checked: Record<string, CreateAttempt> = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (!attempt(entry) || entry.operationId !== id) return null;
    checked[id] = entry;
  }
  return { version: 1, owner, entries: checked };
}
export function createReceipt(value: unknown): CreateReceipt | null {
  if (
    !record(value) ||
    !isUuid(value['recordId']) ||
    !count(value['revision']) ||
    value['revision'] < 1 ||
    !record(value['detail'])
  )
    return null;
  const key = value['detail']['key'] ?? null;
  if (key !== null && (typeof key !== 'string' || key.trim() === '')) return null;
  return { recordId: value['recordId'], revision: value['revision'], key };
}
export function submittedCreate(
  operationId: string,
  title: string,
  editor: CreateEditor,
): CreateAttempt {
  return Object.freeze<CreateAttempt>({
    origin: 'inline',
    operationId,
    editor: Object.freeze({ ...editor }),
    body: Object.freeze({ fields: Object.freeze({ title }), board: null }),
    knowledge: { kind: 'prepared' },
  });
}
