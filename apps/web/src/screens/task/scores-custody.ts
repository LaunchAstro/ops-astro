// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Failure, type Settlement } from '../../records/use-command.ts';
import { tabOwnerGeneration, type StorageLike } from '../../session/token.ts';
import {
  scoresSlot,
  type ScoreAttempt,
  type ScoreEnvelope,
  type ScoreMark,
} from './scores-slot.ts';

export interface ScoreHold {
  readonly pending: ScoreAttempt | null;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly kept: boolean;
  readonly ephemeral: boolean;
  readonly failure: Failure | null;
  readonly changed: number;
}
const EMPTY: ScoreHold = {
  pending: null,
  busy: false,
  uncertain: false,
  kept: true,
  ephemeral: false,
  failure: null,
  changed: 0,
};

/** One exact task.set_scores attempt per task, shared by its page and panel. */
export class ScoresCustody {
  #client: OperationsClient;
  readonly #owner: string;
  readonly #generation = tabOwnerGeneration();
  readonly #slot: ReturnType<typeof scoresSlot>;
  readonly #holds = new Map<string, ScoreHold>();
  readonly #listeners = new Set<() => void>();
  #alive = true;
  #epoch = 0;

  constructor(client: OperationsClient, owner: string, storage: StorageLike | null) {
    this.#client = client;
    this.#owner = owner;
    this.#slot = scoresSlot(storage);
    const kept = this.#slot.read();
    if (kept?.owner === owner) {
      for (const [id, pending] of Object.entries(kept.tasks)) {
        this.#holds.set(id, { ...EMPTY, pending, uncertain: true });
      }
    }
  }
  snapshot = (id: string): ScoreHold => this.#holds.get(id) ?? EMPTY;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #current(): boolean {
    return this.#alive && this.#generation === tabOwnerGeneration();
  }
  #put(id: string, hold: ScoreHold): void {
    this.#holds.set(id, hold);
    for (const listener of this.#listeners) listener();
  }
  #save(): boolean {
    const tasks = Object.fromEntries(
      [...this.#holds].flatMap(([id, hold]) =>
        hold.pending === null || hold.ephemeral ? [] : [[id, hold.pending]],
      ),
    );
    const envelope: ScoreEnvelope = { version: 1, owner: this.#owner, tasks };
    this.#slot.write(envelope);
    return JSON.stringify(this.#slot.read()) === JSON.stringify(envelope);
  }
  activate(): void {
    this.#alive = true;
  }
  dispose = (): void => {
    this.#alive = false;
    this.#epoch += 1;
    if (this.#generation === tabOwnerGeneration()) {
      for (const [id, hold] of this.#holds) {
        if (hold.busy) this.#holds.set(id, { ...hold, busy: false, uncertain: true });
      }
    } else {
      this.#holds.clear();
      if (this.#slot.read()?.owner === this.#owner) this.#slot.remove();
    }
  };
  rebind(client: OperationsClient): void {
    if (client === this.#client) return;
    this.#client = client;
    this.#epoch += 1;
    for (const [id, hold] of this.#holds) {
      if (hold.busy) this.#put(id, { ...hold, busy: false, uncertain: true });
    }
  }
  choose(id: string, revision: number, mark: ScoreMark, value: number | null): void {
    const previous = this.snapshot(id);
    if (
      !this.#current() ||
      previous.busy ||
      previous.pending !== null ||
      (!previous.kept && !previous.ephemeral) ||
      previous.failure?.kind === 'closed'
    )
      return;
    const pending = { operationId: this.#client.newOperationId(), revision, mark, value };
    this.#holds.set(id, { ...previous, pending, ephemeral: false, failure: null });
    void this.#send(id);
  }
  retry(id: string): void {
    if (!this.#current()) return;
    const previous = this.snapshot(id);
    if (previous.busy) return;
    if (previous.pending === null) {
      this.#put(id, { ...previous, kept: this.#save() });
      return;
    }
    void this.#send(id);
  }
  sendEphemeral(id: string): void {
    const previous = this.snapshot(id);
    if (
      !this.#current() ||
      previous.pending === null ||
      previous.busy ||
      previous.uncertain ||
      previous.kept
    )
      return;
    this.#holds.set(id, { ...previous, ephemeral: true });
    void this.#send(id);
  }
  async #send(id: string): Promise<void> {
    const previous = this.snapshot(id);
    const pending = previous.pending;
    if (pending === null || !this.#current()) return;
    if (!previous.ephemeral && !this.#save()) {
      this.#put(id, { ...previous, kept: false });
      return;
    }
    const epoch = this.#epoch;
    this.#put(id, { ...previous, busy: true, kept: !previous.ephemeral, failure: null });
    let answer: Settlement;
    try {
      answer = settle(
        await this.#client.mutate(
          'task.set_scores',
          {
            recordId: id,
            fields: { [pending.mark]: pending.value },
          },
          { operationId: pending.operationId, expectedRevision: pending.revision },
        ),
      );
    } catch {
      answer = { kind: 'unknown', because: 'The score change did not return an answer.' };
    }
    this.#finish(id, previous, pending, answer, epoch);
  }
  #finish(
    id: string,
    previous: ScoreHold,
    pending: ScoreAttempt,
    answer: Settlement,
    epoch: number,
  ): void {
    if (
      !this.#current() ||
      epoch !== this.#epoch ||
      this.snapshot(id).pending?.operationId !== pending.operationId
    )
      return;
    // A refusal now may withhold a stored success; only its success resolves that unknown.
    const uncertain = answer.kind === 'unknown' || (previous.uncertain && answer.kind !== 'ok');
    const next: ScoreHold = {
      ...previous,
      pending: uncertain ? pending : null,
      busy: false,
      uncertain,
      failure: answer.kind === 'ok' ? null : answer,
      changed: previous.changed + (answer.kind === 'ok' ? 1 : 0),
    };
    this.#holds.set(id, next);
    this.#put(id, { ...next, kept: next.ephemeral ? false : this.#save() });
  }
}
