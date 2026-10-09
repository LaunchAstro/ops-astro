// SPDX-License-Identifier: AGPL-3.0-only
import {
  EMPTY,
  readCreateJournal,
  createJournal,
  type CreateState,
  type CreateHold,
} from './create-journal.ts';
export type { CreateHold } from './create-journal.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Settlement } from '../../records/use-command.ts';
import {
  isOperationId,
  isUuid,
  verifiedJsonWrite,
  type StorageLike,
} from '../../session/storage-slot.ts';
import { tabOwnerGeneration } from '../../session/token.ts';
import {
  CREATE_KEY,
  record,
  createReceipt,
  submittedCreate,
  type CreateAttempt,
  type CreateEditor,
  type CreateReceipt,
} from './create-attempt.ts';

const STORAGE =
  'The recovery copy could not be kept. No new task was sent. Retry keeps the same attempt.';

/** Exact inline creates, with separate entries for independently submitted tasks. */
export class CreateCustody {
  readonly #owner: string;
  readonly #storage: StorageLike | null;
  readonly #memoryOnly: boolean;
  readonly #generation = tabOwnerGeneration();
  readonly #listeners = new Set<() => void>();
  readonly #created = new Set<(editor: CreateEditor) => void>();
  #state: CreateState = EMPTY;
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
    this.#state = readCreateJournal(storage, owner);
  }
  snapshot = (): CreateState => this.#state;
  serverSnapshot = (): CreateState => EMPTY;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  created = (listener: (editor: CreateEditor) => void): (() => void) => {
    this.#created.add(listener);
    return () => this.#created.delete(listener);
  };
  activate = (): void => {
    this.#alive = true;
    try {
      if (this.#state.problem !== null && this.#storage?.getItem(CREATE_KEY) === null) {
        this.#state = EMPTY;
        this.#notify();
      }
    } catch {
      /* The malformed or unreadable copy remains withheld. */
    }
  };
  dispose = (): void => {
    this.#alive = false;
    this.#epoch += 1;
    if (this.#generation === tabOwnerGeneration()) return;
    this.#state = { holds: new Map(), problem: null };
    try {
      const raw = this.#storage?.getItem(CREATE_KEY);
      const value: unknown = raw === undefined || raw === null ? null : JSON.parse(raw);
      if (record(value) && value['owner'] === this.#owner) this.#storage?.removeItem(CREATE_KEY);
    } catch {
      /* Persisted session endings remain the reload fence when removal fails. */
    }
  };
  #current(): boolean {
    return this.#alive && this.#generation === tabOwnerGeneration();
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
  #put(id: string, hold: CreateHold | null): void {
    const holds = new Map(this.#state.holds);
    if (hold === null) holds.delete(id);
    else holds.set(id, hold);
    this.#state = { ...this.#state, holds };
    this.#notify();
  }
  #save(): boolean {
    if (!this.#current() || this.#state.problem !== null) return false;
    if (this.#memoryOnly) return true;
    return verifiedJsonWrite(
      this.#storage,
      CREATE_KEY,
      createJournal(this.#owner, this.#state.holds),
    );
  }
  rebind(client: OperationsClient): void {
    if (client === this.#client) return;
    this.#client = client;
    this.#epoch += 1;
    for (const [id, hold] of this.#state.holds)
      if (hold.busy) this.#put(id, { ...hold, busy: false });
  }
  prepare(title: string, editor: CreateEditor): string | null {
    if (
      !this.#current() ||
      this.#state.problem !== null ||
      [...this.#state.holds.values()].some((hold) => !hold.kept)
    )
      return null;
    const id = this.#client.newOperationId();
    if (
      !isOperationId(id) ||
      !isUuid(editor.id) ||
      this.#state.holds.has(id) ||
      title.trim() === ''
    )
      return null;
    this.#put(id, {
      entry: submittedCreate(id, title.trim(), editor),
      busy: false,
      failure: null,
      kept: true,
    });
    return id;
  }
  cleanup(id: string): void {
    const previous = this.#state.holds.get(id);
    if (
      !this.#current() ||
      previous === undefined ||
      previous.busy ||
      previous.entry.knowledge.kind !== 'answered'
    )
      return;
    this.#put(id, null);
    if (!this.#save()) this.#put(id, { ...previous, kept: false });
  }
  async retry(id: string): Promise<Settlement | undefined> {
    const previous = this.#state.holds.get(id);
    if (!this.#current() || previous === undefined || previous.busy || this.#state.problem !== null)
      return;
    if (previous.entry.knowledge.kind === 'answered') {
      this.cleanup(id);
      return;
    }
    const unresolved = previous.entry.knowledge.kind === 'unresolved';
    const entry: CreateAttempt = { ...previous.entry, knowledge: { kind: 'unresolved' } };
    this.#put(id, { ...previous, entry, failure: null });
    if (!this.#save()) {
      this.#put(id, {
        ...previous,
        kept: false,
        failure: {
          kind: 'unknown',
          because: unresolved
            ? 'The recovery copy could not be kept. No replay was sent.'
            : STORAGE,
        },
      });
      return;
    }
    const epoch = this.#epoch;
    this.#put(id, { entry, busy: true, failure: null, kept: true });
    const answer = settle(
      await this.#client.mutate('task.create', entry.body, { operationId: id }),
    );
    if (!this.#current() || epoch !== this.#epoch || this.#state.holds.get(id)?.entry !== entry)
      return;
    const receipt = answer.kind === 'ok' ? createReceipt(answer.value) : null;
    const result: Settlement =
      answer.kind === 'ok' && receipt === null
        ? { kind: 'unknown', because: 'The API did not return a valid task creation receipt.' }
        : answer;
    return this.#settled(id, entry, result, receipt, unresolved);
  }
  #settled(
    id: string,
    entry: CreateAttempt,
    result: Settlement,
    receipt: CreateReceipt | null,
    unresolved: boolean,
  ): Settlement {
    if (result.kind === 'unknown' || (unresolved && result.kind !== 'ok')) {
      this.#put(id, {
        entry,
        busy: false,
        failure: result,
        kept: true,
      });
      return result;
    }
    const answered: CreateAttempt = {
      ...entry,
      knowledge: {
        kind: 'answered',
        receipt,
        refusal: result.kind === 'ok' ? null : result.refusal.code,
      },
    };
    this.#put(id, {
      entry: answered,
      busy: false,
      failure: result.kind === 'ok' ? null : result,
      kept: true,
    });
    const kept = this.#save();
    this.#put(id, { ...this.#state.holds.get(id)!, kept });
    if (result.kind === 'ok') for (const listener of new Set(this.#created)) listener(entry.editor);
    this.cleanup(id);
    return result;
  }
}
