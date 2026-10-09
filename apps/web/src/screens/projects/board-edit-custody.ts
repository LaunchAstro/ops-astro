// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Settlement } from '../../records/use-command.ts';
import { isUuid, verifiedJsonWrite, type StorageLike } from '../../session/storage-slot.ts';
import { tabOwnerGeneration } from '../../session/token.ts';
import {
  BOARD_EDIT_KEY,
  record,
  operationId as validOperationId,
  revision,
  boardEditDocument,
  boardEditReceipt,
  type BoardEditEntry,
  type BoardEditIntent,
} from './board-edit-attempt.ts';
export interface BoardEditHold {
  readonly entry: BoardEditEntry;
  readonly busy: boolean;
  readonly kept: boolean;
  readonly notice: string | null;
}
interface BoardEditState {
  readonly holds: ReadonlyMap<string, BoardEditHold>;
  readonly problem: string | null;
  readonly changed: number;
}
const EMPTY: BoardEditState = { holds: new Map(), problem: null, changed: 0 };
const RECOVERY = 'The saved board change could not be recovered. No stored change was sent.';
export class BoardEditCustody {
  readonly #owner: string;
  readonly #storage: StorageLike | null;
  readonly #memoryOnly: boolean;
  readonly #generation = tabOwnerGeneration();
  readonly #listeners = new Set<() => void>();
  readonly #settlements = new Set<(entry: BoardEditEntry, answer: Settlement) => void>();
  #state: BoardEditState = EMPTY;
  #client: OperationsClient;
  #alive = true;
  #epoch = 0;
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
      const raw = storage?.getItem(BOARD_EDIT_KEY) ?? null;
      if (raw === null) return;
      const entries = boardEditDocument(JSON.parse(raw) as unknown, owner);
      this.#state =
        entries === null
          ? { ...EMPTY, problem: RECOVERY }
          : {
              ...EMPTY,
              holds: new Map(
                [...entries].map(([id, entry]) => [
                  id,
                  { entry, busy: false, kept: true, notice: null },
                ]),
              ),
            };
    } catch {
      this.#state = { ...EMPTY, problem: RECOVERY };
    }
  }
  snapshot = (): BoardEditState => this.#state;
  serverSnapshot = (): BoardEditState => EMPTY;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  settled = (listener: (entry: BoardEditEntry, answer: Settlement) => void): (() => void) => {
    this.#settlements.add(listener);
    return () => this.#settlements.delete(listener);
  };
  activate = (): void => {
    this.#alive = true;
    try {
      if (this.#state.problem !== null && this.#storage?.getItem(BOARD_EDIT_KEY) === null) {
        this.#state = EMPTY;
        this.#notify();
      }
    } catch {
      /* Unreadable recovery remains withheld. */
    }
  };
  dispose = (): void => {
    this.#alive = false;
    this.#epoch += 1;
    if (this.#generation === tabOwnerGeneration()) return;
    this.#state = EMPTY;
    try {
      const raw = this.#storage?.getItem(BOARD_EDIT_KEY);
      const value: unknown = raw === undefined || raw === null ? null : JSON.parse(raw);
      if (record(value) && value['owner'] === this.#owner)
        this.#storage?.removeItem(BOARD_EDIT_KEY);
    } catch {
      /* Persisted session endings fence a failed removal. */
    }
  };
  #current(): boolean {
    return this.#alive && this.#generation === tabOwnerGeneration();
  }
  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
  #put(id: string, hold: BoardEditHold | null): void {
    const holds = new Map(this.#state.holds);
    if (hold === null) holds.delete(id);
    else holds.set(id, hold);
    this.#state = { ...this.#state, holds };
    this.#notify();
  }
  #save(): boolean {
    if (!this.#current() || this.#state.problem !== null) return false;
    return (
      this.#memoryOnly ||
      verifiedJsonWrite(this.#storage, BOARD_EDIT_KEY, {
        version: 1,
        owner: this.#owner,
        tasks: Object.fromEntries(
          [...this.#state.holds]
            .filter(([, hold]) => hold.entry.knowledge !== 'prepared')
            .map(([id, hold]) => [id, hold.entry]),
        ),
      })
    );
  }
  rebind(client: OperationsClient): void {
    if (client === this.#client) return;
    this.#client = client;
    this.#epoch += 1;
    for (const [id, hold] of this.#state.holds)
      if (hold.busy) this.#put(id, { ...hold, busy: false });
  }
  choose(intent: BoardEditIntent, expectedRevision: number | undefined): boolean {
    const id = intent.body.recordId;
    if (
      !this.#current() ||
      this.#state.problem !== null ||
      this.#state.holds.has(id) ||
      [...this.#state.holds.values()].some((hold) => !hold.kept)
    )
      return false;
    if (!this.#memoryOnly && (!isUuid(id) || !revision(expectedRevision))) return false;
    const operationId = this.#client.newOperationId();
    if (
      !validOperationId(operationId) ||
      [...this.#state.holds.values()].some((hold) => hold.entry.attempt.operationId === operationId)
    )
      return false;
    if ('fields' in intent.body) Object.freeze(intent.body.fields);
    Object.freeze(intent.body);
    const entry: BoardEditEntry = {
      attempt: Object.freeze({ ...intent, operationId, expectedRevision: expectedRevision ?? 0 }),
      knowledge: 'prepared',
    };
    this.#put(id, { entry, busy: false, kept: true, notice: null });
    void this.retry(id);
    return true;
  }
  cleanup(id: string): void {
    const previous = this.#state.holds.get(id);
    if (
      !this.#current() ||
      previous === undefined ||
      previous.busy ||
      previous.entry.knowledge !== 'answered'
    )
      return;
    this.#put(id, null);
    if (!this.#save())
      this.#put(id, {
        ...previous,
        kept: false,
        notice: 'The answer is known. Retry only removes the recovery copy; it sends no change.',
      });
  }
  async retry(id: string): Promise<void> {
    const previous = this.#state.holds.get(id);
    if (!this.#current() || previous === undefined || previous.busy || this.#state.problem !== null)
      return;
    if (previous.entry.knowledge === 'answered') {
      this.cleanup(id);
      return;
    }
    const uncertain = previous.entry.knowledge === 'unresolved';
    const entry: BoardEditEntry = { ...previous.entry, knowledge: 'unresolved' };
    this.#put(id, { ...previous, entry, notice: null });
    if (!this.#save()) {
      this.#put(id, {
        ...previous,
        kept: false,
        notice: uncertain
          ? 'The recovery copy could not be kept. No retry was sent.'
          : 'The recovery copy could not be kept. No new change was sent.',
      });
      return;
    }
    const epoch = this.#epoch;
    this.#put(id, { entry, busy: true, kept: true, notice: null });
    const attempt = entry.attempt;
    const answer = settle(
      await this.#client.mutate(attempt.command, attempt.body, {
        operationId: attempt.operationId,
        ...(attempt.expectedRevision === 0 && this.#memoryOnly
          ? {}
          : { expectedRevision: attempt.expectedRevision }),
      }),
    );
    if (!this.#current() || epoch !== this.#epoch || this.#state.holds.get(id)?.entry !== entry)
      return;
    const result: Settlement =
      answer.kind === 'ok' && !this.#memoryOnly && !boardEditReceipt(answer.value, id)
        ? { kind: 'unknown', because: 'The API did not return a valid board change receipt.' }
        : answer;
    this.#settled(id, entry, result, uncertain);
  }
  #settled(id: string, entry: BoardEditEntry, result: Settlement, uncertain: boolean): void {
    if (result.kind === 'unknown' || (uncertain && result.kind !== 'ok')) {
      this.#put(id, {
        entry,
        busy: false,
        kept: true,
        notice: 'The change may already have been applied. ' + result.because,
      });
    } else {
      this.#put(id, {
        entry: { ...entry, knowledge: 'answered' },
        busy: false,
        kept: true,
        notice: result.kind === 'ok' ? null : 'The change was not made: ' + result.because,
      });
      const kept = this.#save();
      this.#put(id, { ...this.#state.holds.get(id)!, kept });
      this.cleanup(id);
    }
    for (const listener of new Set(this.#settlements)) listener(entry, result);
    this.#state = { ...this.#state, changed: this.#state.changed + 1 };
    this.#notify();
  }
}
