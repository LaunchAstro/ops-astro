// SPDX-License-Identifier: AGPL-3.0-only
//
// C2 on the live channel: the presence book (presence.ts) and who on this
// process hears each watched task. A tab's stream seats itself on every task
// it watches and leaves as each topic closes or the stream ends; a change in
// the book reaches the streams on that task as `presence`, the topic alone,
// and each re-reads who else is there. Everything is keyed by the business
// the stream was admitted to. A seat is named by an id the stream alone was
// handed, and only its own person may mark or read through it.

import { refuseCommand, type CommandRefusal } from '../../packages/core-commands/src/index.ts';
import { TASK_SPINE } from '../../packages/core-records/src/index.ts';
import { PresenceBook, type PresenceSession, type PresenceView } from './presence.ts';
import { TOPIC } from './live.ts';

export interface LivePresence {
  /** Seat `session` on a watched task and hear its changes; the returned function leaves, once. */
  seat(businessId: string, taskId: string, session: PresenceSession, heard: () => void): () => void;
  /** The field `personId`'s seat is changing, or null; false when that seat is not theirs here. */
  mark(
    businessId: string,
    taskId: string,
    seatId: string,
    personId: string,
    field: string | null,
  ): boolean;
  /** Who else is on the task, seen from `personId`'s seat; undefined when it is not theirs here. */
  seenBy(
    businessId: string,
    taskId: string,
    seatId: string,
    personId: string,
  ): readonly PresenceView[] | undefined;
  /** Seats, topics and listeners kept, for the proof that a leaving keeps nothing. */
  readonly held: number;
}

class LivePresenceHub implements LivePresence {
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #book = new PresenceBook((businessId, taskId) => {
    for (const heard of this.#listeners.get(keyOf(businessId, taskId)) ?? []) heard();
  });

  seat(businessId: string, taskId: string, session: PresenceSession, heard: () => void) {
    const key = keyOf(businessId, taskId);
    const listeners = this.#listeners.get(key) ?? new Set<() => void>();
    this.#listeners.set(key, listeners);
    const own = (): void => heard();
    listeners.add(own);
    const leave = this.#book.join(businessId, taskId, session);
    return () => {
      listeners.delete(own);
      if (listeners.size === 0 && this.#listeners.get(key) === listeners) {
        this.#listeners.delete(key);
      }
      leave();
    };
  }

  mark(businessId: string, taskId: string, seatId: string, personId: string, field: string | null) {
    if (this.#book.seatedAs(businessId, taskId, seatId) !== personId) return false;
    return this.#book.mark(businessId, taskId, seatId, field);
  }

  seenBy(businessId: string, taskId: string, seatId: string, personId: string) {
    if (this.#book.seatedAs(businessId, taskId, seatId) !== personId) return;
    return this.#book.seenBy(businessId, taskId, seatId);
  }

  get held(): number {
    return this.#book.held + this.#listeners.size;
  }
}

const keyOf = (businessId: string, taskId: string): string => `${businessId}/${taskId}`;

export function createLivePresence(): LivePresence {
  return new LivePresenceHub();
}

const SEAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** The task's own fields, by key: the only names a mark may carry. */
const FIELDS: ReadonlySet<string> = new Set(TASK_SPINE.map((field) => field.key));
const ASKED = 'Send seat, the id your stream was handed, and topic, as task:<id>.';
const MARKED = `${ASKED} Send field as one of the task's field keys, or null when you stop.`;

/** Which seat asks about which task. */
export interface SeatAsk {
  readonly seat: string;
  readonly taskId: string;
}

/** A mark's seat, task and field, or the refusal naming what did not match; nothing read yet. */
export function markOf(
  body: Readonly<Record<string, unknown>>,
): (SeatAsk & { readonly field: string | null }) | CommandRefusal {
  const asked = seatAskOf(body, ['seat', 'topic', 'field'], MARKED);
  if ('code' in asked) return asked;
  const { field } = body;
  if (field === null || (typeof field === 'string' && FIELDS.has(field)))
    return { ...asked, field };
  return refuseCommand('FIELD_VALUE_INVALID', ['field'], [MARKED]);
}

/** A presence read's seat and task, from the query, each named once; nothing read yet. */
export function presenceAskOf(
  queries: Readonly<Record<string, readonly string[]>>,
): SeatAsk | CommandRefusal {
  const single: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(queries)) {
    single[name] = values.length === 1 ? values[0] : values;
  }
  return seatAskOf(single, ['seat', 'topic'], ASKED);
}

function seatAskOf(
  given: Readonly<Record<string, unknown>>,
  names: readonly string[],
  fix: string,
): SeatAsk | CommandRefusal {
  const unknown = Object.keys(given).filter((name) => !names.includes(name));
  if (unknown.length > 0) return refuseCommand('FIELD_UNKNOWN', unknown, [fix]);
  const { seat, topic } = given;
  if (typeof seat !== 'string' || !SEAT.test(seat)) {
    return refuseCommand('FIELD_VALUE_INVALID', ['seat'], [fix]);
  }
  const taskId = typeof topic === 'string' ? TOPIC.exec(topic)?.[1] : undefined;
  if (taskId === undefined) return refuseCommand('FIELD_VALUE_INVALID', ['topic'], [fix]);
  return { seat, taskId };
}
