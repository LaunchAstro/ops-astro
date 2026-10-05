// SPDX-License-Identifier: AGPL-3.0-only
//
// One operation id per intent (`data/owned.ts`, the web-writes rule): the same
// value saved again after an answer that never arrived is a retry of the same
// intent, and carries the same id, so the server replays a stored success
// instead of storing it twice. Any answer, or another value, is a new intent.

/**
 * The operation id for each intent in flight, by key, with what its first
 * attempt was sent with (a revision, say). An attempt whose answer never
 * arrived keeps both for the same value, so a retry is byte for byte the
 * request the server may already hold; `answered` ends the intent.
 */
export class Intents {
  readonly #held = new Map<
    string,
    { readonly value: string; readonly id: string; readonly sentWith: unknown }
  >();

  /**
   * The id and the `sentWith` to send `value` under `key` with: the unanswered
   * attempt's, when it is the same value; else a new id and this `sentWith`.
   */
  attempt<T>(
    key: string,
    value: unknown,
    sentWith: T,
  ): { readonly id: string; readonly sentWith: T } {
    const same = JSON.stringify(value) ?? 'undefined';
    const held = this.#held.get(key);
    if (held?.value === same) return { id: held.id, sentWith: held.sentWith as T };
    const id = crypto.randomUUID();
    this.#held.set(key, { value: same, id, sentWith });
    return { id, sentWith };
  }

  /** The id alone, for a save that sends nothing beside its value. */
  idFor(key: string, value: unknown): string {
    return this.attempt(key, value, null).id;
  }

  /** An answer arrived for the attempt sent under `id`: the next save of `key` is a new intent. */
  answered(key: string, id: string): void {
    if (this.#held.get(key)?.id === id) this.#held.delete(key);
  }
}
