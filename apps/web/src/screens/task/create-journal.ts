// SPDX-License-Identifier: AGPL-3.0-only
import type { Failure } from '../../records/use-command.ts';
import type { StorageLike } from '../../session/storage-slot.ts';
import { CREATE_KEY, createDocument, type CreateAttempt } from './create-attempt.ts';
export interface CreateHold {
  readonly entry: CreateAttempt;
  readonly busy: boolean;
  readonly failure: Failure | null;
  readonly kept: boolean;
}
export interface CreateState {
  readonly holds: ReadonlyMap<string, CreateHold>;
  readonly problem: string | null;
}
export const EMPTY: CreateState = { holds: new Map(), problem: null };
const RECOVERY = 'The saved task creation could not be recovered. No stored attempt was sent.';
export function readCreateJournal(storage: StorageLike | null, owner: string): CreateState {
  try {
    const raw = storage?.getItem(CREATE_KEY) ?? null;
    if (raw === null) return EMPTY;
    const document = createDocument(JSON.parse(raw) as unknown, owner);
    if (document === null) {
      return { holds: new Map(), problem: RECOVERY };
    }
    return {
      holds: new Map(
        Object.entries(document.entries).map(([id, entry]) => [
          id,
          { entry, busy: false, failure: null, kept: true },
        ]),
      ),
      problem: null,
    };
  } catch {
    return { holds: new Map(), problem: RECOVERY };
  }
}
export function createJournal(
  owner: string,
  holds: ReadonlyMap<string, CreateHold>,
  submitted?: CreateAttempt,
) {
  return {
    version: 1 as const,
    owner,
    entries: {
      ...Object.fromEntries(
        [...holds]
          .filter(([, hold]) => hold.entry.knowledge.kind !== 'prepared')
          .map(([id, hold]) => [id, hold.entry]),
      ),
      ...(submitted === undefined ? {} : { [submitted.operationId]: submitted }),
    },
  };
}
