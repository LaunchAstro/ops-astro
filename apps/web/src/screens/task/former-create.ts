// SPDX-License-Identifier: AGPL-3.0-only
//
// The Projects inline Create that came before the kept draft journalled a
// Create with no answer under `ops-astro.create-attempts`. A tab open across
// the upgrade may still hold one: it becomes the person's kept draft, held
// under its original operation id, so Retry replays it rather than making the
// task twice. Drop this once no deployment runs the inline Create.

import { isOperationId } from '../../session/storage-slot.ts';
import { sessionGeneration } from './draft-storage.ts';
import { emptyDraft, keepDraft, newAttempt, readDraft } from './task-draft.ts';

const FORMER_KEY = 'ops-astro.create-attempts';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The journalled title of an unresolved inline Create under `id`, or null. */
function unresolvedTitle(id: string, entry: unknown): string | null {
  if (!record(entry) || entry['operationId'] !== id || !isOperationId(id)) return null;
  const { body, knowledge } = entry;
  if (!record(knowledge) || knowledge['kind'] !== 'unresolved') return null;
  if (!record(body) || body['board'] !== null || Object.keys(body).length !== 2) return null;
  const fields = body['fields'];
  if (!record(fields) || Object.keys(fields).length !== 1) return null;
  const title = fields['title'];
  return typeof title === 'string' && title !== '' && title === title.trim() ? title : null;
}

/** With no draft kept, the person's first unresolved inline Create becomes it. */
export function adoptFormerCreate(storage: Storage | null, person: string): void {
  try {
    const raw = storage?.getItem(FORMER_KEY) ?? null;
    if (storage === null || raw === null || readDraft(storage, person) !== null) return;
    const journal: unknown = JSON.parse(raw);
    const owner = `${person}:${String(sessionGeneration())}`;
    if (!record(journal) || journal['version'] !== 1 || journal['owner'] !== owner) return;
    if (!record(journal['entries'])) return;
    const held = Object.entries(journal['entries']).filter(
      ([id, entry]) => unresolvedTitle(id, entry) !== null,
    );
    const [first, ...rest] = held;
    if (first !== undefined) {
      const title = unresolvedTitle(...first) ?? '';
      const draft = { ...emptyDraft(null), title, from: 'Projects' };
      if (!keepDraft(storage, person, draft, newAttempt(first[0]))) return;
    }
    if (rest.length === 0) storage.removeItem(FORMER_KEY);
    else
      storage.setItem(
        FORMER_KEY,
        JSON.stringify({ ...journal, entries: Object.fromEntries(rest) }),
      );
  } catch {
    // Unreadable or unwritable: the former journal stays as it was.
  }
}
