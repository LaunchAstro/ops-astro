// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Failure, type Settlement } from '../../records/use-command.ts';
import { isRecord, isUuid, type StorageLike } from '../../session/storage-slot.ts';
import { tabOwnerGeneration } from '../../session/token.ts';

/** The complete original task.comment envelope, without a transport or credential. */
export interface PendingComment {
  readonly mentions?: readonly string[];
  readonly operationId: string;
  readonly revision: number;
  readonly body: string;
  readonly audience: string;
  readonly kind: string;
  readonly parentId: string | null;
}

export interface CommentHold {
  readonly pending: PendingComment | null;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failure: Failure | null;
  readonly settlement: number;
  readonly answered: Settlement['kind'] | null;
  readonly settled: PendingComment | null;
  readonly kept: boolean;
}
const EMPTY: CommentHold = {
  pending: null,
  busy: false,
  uncertain: false,
  failure: null,
  settlement: 0,
  answered: null,
  settled: null,
  kept: true,
};
const KEY = 'ops-astro.comment-attempts';
const STORAGE_FAILURE =
  'The recovery copy could not be kept. No new comment was sent. Retry keeps the same attempt.';

function attemptFrom(value: unknown): PendingComment | null {
  if (
    !isRecord(value) ||
    !isUuid(value['operationId']) ||
    !Number.isSafeInteger(value['revision']) ||
    Number(value['revision']) < 0 ||
    typeof value['body'] !== 'string' ||
    (value['audience'] !== 'internal' && value['audience'] !== 'client') ||
    (value['kind'] !== 'note' && value['kind'] !== 'client') ||
    (value['audience'] === 'internal' ? value['kind'] !== 'note' : value['kind'] !== 'client') ||
    (value['parentId'] !== null && !isUuid(value['parentId'])) ||
    (value['mentions'] !== undefined &&
      (!Array.isArray(value['mentions']) || !value['mentions'].every(isUuid))) ||
    Object.keys(value).some(
      (key) =>
        !['operationId', 'revision', 'body', 'audience', 'kind', 'parentId', 'mentions'].includes(
          key,
        ),
    )
  )
    return null;
  return Object.freeze({
    operationId: value['operationId'],
    revision: Number(value['revision']),
    body: value['body'],
    audience: value['audience'],
    kind: value['kind'],
    parentId: value['parentId'],
    ...(value['mentions'] === undefined ? {} : { mentions: Object.freeze([...value['mentions']]) }),
  });
}

/** One exact attempt per task, shared by every page/panel observer in this App owner. */
export class CommentCustody {
  readonly #owner: string;
  readonly #storage: StorageLike | null;
  readonly #memoryOnly: boolean;
  readonly #generation = tabOwnerGeneration();
  readonly #listeners = new Set<() => void>();
  readonly #holds = new Map<string, CommentHold>();
  #client: OperationsClient;
  #epoch = 0;
  #alive = true;

  constructor(
    client: OperationsClient,
    owner: string,
    storage: StorageLike | null,
    memoryOnly = false,
  ) {
    this.#client = client;
    this.#owner = owner;
    this.#storage = storage;
    this.#memoryOnly = memoryOnly;
    try {
      const raw = storage?.getItem(KEY);
      const value: unknown = raw === null || raw === undefined ? null : JSON.parse(raw);
      if (
        !isRecord(value) ||
        value['version'] !== 1 ||
        value['owner'] !== owner ||
        !isRecord(value['tasks'])
      )
        return;
      for (const [id, words] of Object.entries(value['tasks'])) {
        const pending = attemptFrom(words);
        if (isUuid(id) && pending !== null)
          this.#holds.set(id, { ...EMPTY, pending, uncertain: true });
      }
    } catch {
      // An unreadable copy is never authority to dispatch. save() reports failed custody.
    }
  }

  snapshot = (id: string): CommentHold => this.#holds.get(id) ?? EMPTY;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  dispose = (): void => {
    const departed = this.#generation !== tabOwnerGeneration();
    this.#alive = false;
    this.#epoch += 1;
    if (!departed) return;
    this.#holds.clear();
    try {
      const raw = this.#storage?.getItem(KEY);
      const kept: unknown = raw === undefined || raw === null ? null : JSON.parse(raw);
      if (isRecord(kept) && kept['owner'] === this.#owner) this.#storage?.removeItem(KEY);
    } catch {
      // Failed removal cannot restore this retired owner. Durable ending identity is the reload fence.
    }
  };
  activate = (): void => {
    this.#alive = true;
  };
  #current(): boolean {
    return this.#alive && this.#generation === tabOwnerGeneration();
  }
  #put(id: string, hold: CommentHold): void {
    this.#holds.set(id, hold);
    for (const listener of this.#listeners) listener();
  }
  #save(): boolean {
    if (this.#memoryOnly) return true;
    if (this.#storage === null || !this.#current()) return false;
    const tasks = Object.fromEntries(
      [...this.#holds]
        .filter(([, hold]) => hold.pending !== null)
        .map(([id, hold]) => [id, hold.pending]),
    );
    const raw = JSON.stringify({ version: 1, owner: this.#owner, tasks });
    try {
      this.#storage.setItem(KEY, raw);
      return this.#storage.getItem(KEY) === raw;
    } catch {
      return false;
    }
  }

  rebind(client: OperationsClient): void {
    if (client === this.#client) return;
    this.#client = client;
    this.#epoch += 1;
    for (const [id, hold] of this.#holds) {
      if (hold.busy) this.#put(id, { ...hold, busy: false, uncertain: true });
    }
  }

  cleanup(id: string): void {
    const previous = this.snapshot(id);
    if (!this.#current() || previous.busy || previous.pending !== null) return;
    this.#put(id, { ...previous, kept: this.#save() });
  }

  async post(id: string, proposed: PendingComment, alreadyUncertain = false): Promise<void> {
    if (!this.#current()) return;
    const previous = this.snapshot(id);
    if (previous.busy || (previous.failure?.kind === 'closed' && !previous.uncertain)) return;
    // A settled answer whose durable cleanup failed retries cleanup only, never a command.
    if (!previous.kept && previous.pending === null) {
      this.cleanup(id);
      return;
    }
    const pending =
      previous.pending ??
      Object.freeze({
        ...proposed,
        ...(proposed.mentions === undefined
          ? {}
          : { mentions: Object.freeze([...proposed.mentions]) }),
      });
    this.#holds.set(id, { ...previous, pending, failure: null });
    if (!this.#save()) {
      this.#put(id, {
        ...previous,
        pending,
        kept: false,
        failure: { kind: 'unknown', because: STORAGE_FAILURE },
      });
      return;
    }
    const epoch = this.#epoch;
    this.#put(id, { ...previous, pending, busy: true, kept: true, failure: null });
    const answer = settle(
      await this.#client.mutate(
        'task.comment',
        {
          recordId: id,
          body: pending.body,
          audience: pending.audience,
          commentType: pending.kind,
          ...(pending.parentId === null ? {} : { parentId: pending.parentId }),
          ...(pending.mentions === undefined || pending.mentions.length === 0
            ? {}
            : { mentions: pending.mentions }),
        },
        { operationId: pending.operationId, expectedRevision: pending.revision },
      ),
    );
    this.#finish(id, pending, previous, answer, epoch, alreadyUncertain);
  }

  #finish(
    id: string,
    pending: PendingComment,
    previous: CommentHold,
    answer: Settlement,
    epoch: number,
    alreadyUncertain: boolean,
  ): void {
    if (
      !this.#current() ||
      epoch !== this.#epoch ||
      this.snapshot(id).pending?.operationId !== pending.operationId
    )
      return;
    const unknown =
      answer.kind === 'unknown' ||
      ((previous.uncertain || alreadyUncertain) && answer.kind === 'closed');
    const next: CommentHold = {
      pending: unknown ? pending : null,
      busy: false,
      uncertain: unknown,
      failure: answer.kind === 'ok' ? null : answer,
      settlement: previous.settlement + (unknown ? 0 : 1),
      answered: unknown ? null : answer.kind,
      settled: unknown ? null : pending,
      kept: true,
    };
    this.#holds.set(id, next);
    const kept = this.#save();
    this.#put(id, { ...next, kept });
  }
}
