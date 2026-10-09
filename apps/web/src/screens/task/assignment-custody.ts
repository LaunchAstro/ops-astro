// SPDX-License-Identifier: AGPL-3.0-only
import type { OperationsClient } from '../../operations/client.ts';
import { settle, type Failure, type Settlement } from '../../records/use-command.ts';
import {
  isRecord,
  isUuid,
  jsonSlot,
  verifiedJsonWrite,
  type StorageLike,
} from '../../session/storage-slot.ts';
import { tabOwnerGeneration } from '../../session/token.ts';

export type AssignmentFields = { readonly assignee: string | null } | { readonly agent: string };
interface PendingAssignment {
  readonly operationId: string;
  readonly revision: number | undefined;
  readonly fields: AssignmentFields;
}
export interface AssignmentHold {
  readonly pending: PendingAssignment | null;
  readonly busy: boolean;
  readonly uncertain: boolean;
  readonly failure: Failure | null;
  readonly kept: boolean;
}
interface AssignmentState {
  readonly holds: ReadonlyMap<string, AssignmentHold>;
  readonly changed: number;
}
export const EMPTY_ASSIGNMENT: AssignmentHold = {
  pending: null,
  busy: false,
  uncertain: false,
  failure: null,
  kept: true,
};
const KEY = 'ops-astro.assignment-attempts';

function pendingFrom(value: unknown): PendingAssignment | null {
  if (
    !isRecord(value) ||
    !isUuid(value['operationId']) ||
    !Number.isSafeInteger(value['revision']) ||
    Number(value['revision']) < 0 ||
    !isRecord(value['fields']) ||
    Object.keys(value).some((key) => !['operationId', 'revision', 'fields'].includes(key))
  )
    return null;
  const fields = value['fields'];
  if (Object.keys(fields).length !== 1) return null;
  const operand: AssignmentFields | null =
    fields['assignee'] === null || isUuid(fields['assignee'])
      ? { assignee: fields['assignee'] }
      : isUuid(fields['agent'])
        ? { agent: fields['agent'] }
        : null;
  return operand === null
    ? null
    : Object.freeze({
        operationId: value['operationId'],
        revision: Number(value['revision']),
        fields: Object.freeze(operand),
      });
}

/** Exact task.assign custody; a stored attempt contains no label, token or inferred grant. */
export class AssignmentCustody {
  readonly #owner: string;
  readonly #storage: StorageLike | null;
  readonly #memoryOnly: boolean;
  readonly #generation = tabOwnerGeneration();
  readonly #listeners = new Set<() => void>();
  #state: AssignmentState = { holds: new Map(), changed: 0 };
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
    const value = jsonSlot(storage, KEY, isRecord).read();
    if (value?.['version'] !== 1 || value['owner'] !== owner || !isRecord(value['tasks'])) return;
    const holds = new Map<string, AssignmentHold>();
    for (const [id, words] of Object.entries(value['tasks'])) {
      const pending = pendingFrom(words);
      if (isUuid(id) && pending !== null)
        holds.set(id, { ...EMPTY_ASSIGNMENT, pending, uncertain: true });
    }
    this.#state = { holds, changed: 0 };
  }

  snapshot = (): AssignmentState => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  activate = (): void => {
    this.#alive = true;
  };
  dispose = (): void => {
    this.#alive = false;
    this.#epoch += 1;
    if (this.#generation === tabOwnerGeneration()) return;
    this.#state = { holds: new Map(), changed: 0 };
    const slot = jsonSlot(this.#storage, KEY, isRecord);
    if (slot.read()?.['owner'] === this.#owner) slot.remove();
  };
  #current(): boolean {
    return this.#alive && this.#generation === tabOwnerGeneration();
  }
  #put(id: string, hold: AssignmentHold, changed = false): void {
    const holds = new Map<string, AssignmentHold>([...this.#state.holds, [id, hold]]);
    this.#state = { holds, changed: this.#state.changed + Number(changed) };
    for (const listener of this.#listeners) listener();
  }
  #save(): boolean {
    if (this.#memoryOnly) return true;
    if (!this.#current()) return false;
    const tasks = Object.fromEntries(
      [...this.#state.holds]
        .filter(([, hold]) => hold.pending !== null)
        .map(([id, hold]) => [id, hold.pending]),
    );
    return verifiedJsonWrite(this.#storage, KEY, { version: 1, owner: this.#owner, tasks });
  }

  rebind(client: OperationsClient): void {
    if (client === this.#client) return;
    this.#client = client;
    this.#epoch += 1;
    for (const [id, hold] of this.#state.holds) {
      if (hold.busy) this.#put(id, { ...hold, busy: false, uncertain: true });
    }
  }

  async choose(
    id: string,
    revision: number | undefined,
    fields: AssignmentFields,
  ): Promise<Settlement | undefined> {
    const previous = this.#state.holds.get(id) ?? EMPTY_ASSIGNMENT;
    if (
      !this.#current() ||
      previous.pending !== null ||
      !previous.kept ||
      previous.failure?.kind === 'closed' ||
      (revision === undefined && !this.#memoryOnly)
    )
      return;
    const pending = Object.freeze({
      operationId: this.#client.newOperationId(),
      revision,
      fields: Object.freeze({ ...fields }),
    });
    return await this.#post(id, pending);
  }

  async retry(id: string): Promise<Settlement | undefined> {
    const hold = this.#state.holds.get(id) ?? EMPTY_ASSIGNMENT;
    if (!this.#current() || hold.busy) return;
    if (hold.pending !== null) return await this.#post(id, hold.pending);
    if (!hold.kept) this.#put(id, { ...hold, kept: this.#save() });
    return undefined;
  }

  async #post(id: string, pending: PendingAssignment): Promise<Settlement | undefined> {
    const previous = this.#state.holds.get(id) ?? EMPTY_ASSIGNMENT;
    if (!this.#current() || previous.busy) return undefined;
    this.#put(id, { ...previous, pending, failure: null });
    if (!this.#save()) {
      this.#put(id, {
        ...previous,
        pending,
        kept: false,
        failure: {
          kind: 'unknown',
          because:
            'The recovery copy could not be kept. No new assignment was sent. Retry keeps the same attempt.',
        },
      });
      return undefined;
    }
    const epoch = this.#epoch;
    this.#put(id, { ...previous, pending, busy: true, kept: true, failure: null });
    const answer = await this.#send(id, pending);
    if (
      !this.#current() ||
      epoch !== this.#epoch ||
      this.#state.holds.get(id)?.pending?.operationId !== pending.operationId
    )
      return undefined;
    // Replay skips the task revision check. Other current-authority refusals may withhold a recorded success.
    const unknown =
      answer.kind === 'unknown' ||
      (previous.uncertain && answer.kind !== 'ok' && answer.kind !== 'stale');
    const next = {
      pending: unknown ? pending : null,
      busy: false,
      uncertain: unknown,
      failure: answer.kind === 'ok' ? null : answer,
      kept: true,
    };
    this.#put(id, next);
    const kept = this.#save();
    this.#put(id, { ...next, kept }, true);
    return unknown ? { kind: 'unknown', because: answer.because } : answer;
  }

  async #send(id: string, pending: PendingAssignment): Promise<Settlement> {
    try {
      return settle(
        await this.#client.mutate(
          'task.assign',
          { recordId: id, fields: pending.fields },
          {
            operationId: pending.operationId,
            ...(pending.revision === undefined ? {} : { expectedRevision: pending.revision }),
          },
        ),
      );
    } catch {
      return { kind: 'unknown', because: 'No answer came back.' };
    }
  }
}
