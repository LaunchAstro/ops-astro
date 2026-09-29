// SPDX-License-Identifier: AGPL-3.0-only
//
// C2: live presence, the book the live channel keeps it in.
//
// Presence is advisory (docs/decisions/delivery-and-presence.md, "Live presence
// and real-time state"): nothing depends on it, nothing is audited and nothing
// is retained. So the book lives in memory beside the live channel's fan-out
// and is keyed the same way, by the business the session was admitted to and
// never one a caller named. A stream's join is a viewing and its end is the
// leaving, at once: there is no idle timer and no heartbeat figure to choose.
// Starting to change a field is marked by a session already joined to the
// topic, and the join is where the live channel checks the reader may read it.
//
// A client session neither sees staff presence nor is seen, so a client's
// seat is held only for its own leaving and never listed or announced. A
// change is announced as its business and topic and nothing else, the same
// content-free invalidation every live message is; the page re-reads.

export type PresenceSide = 'staff' | 'client';

export interface PresenceSession {
  readonly sessionId: string;
  readonly personId: string;
  readonly name: string;
  readonly side: PresenceSide;
}

export interface PresenceView {
  readonly personId: string;
  readonly name: string;
  readonly state: 'viewing' | 'changing';
  /** The field being changed, when the state is `changing`. */
  readonly field: string | null;
}

export type PresenceChanged = (businessId: string, topic: string) => void;

interface Seat {
  readonly session: PresenceSession;
  field: string | null;
}

/** Sessions by id, in the order they joined. */
type Topic = Map<string, Seat>;

export class PresenceBook {
  readonly #changed: PresenceChanged;
  readonly #businesses = new Map<string, Map<string, Topic>>();

  constructor(changed: PresenceChanged) {
    this.#changed = changed;
  }

  /** Seat `session` on `topic`; the returned function leaves, once. */
  join(businessId: string, topic: string, session: PresenceSession): () => void {
    const topics = this.#businesses.get(businessId) ?? new Map<string, Topic>();
    this.#businesses.set(businessId, topics);
    const seats = topics.get(topic) ?? new Map<string, Seat>();
    topics.set(topic, seats);
    const seat: Seat = { session, field: null };
    seats.set(session.sessionId, seat);
    this.#announce(businessId, topic, seat);
    return () => {
      // A rejoin under the same session replaced this seat; its leave is spent.
      if (seats.get(session.sessionId) !== seat) return;
      seats.delete(session.sessionId);
      if (seats.size === 0 && topics.get(topic) === seats) topics.delete(topic);
      if (topics.size === 0 && this.#businesses.get(businessId) === topics) {
        this.#businesses.delete(businessId);
      }
      this.#announce(businessId, topic, seat);
    };
  }

  /** The field a joined staff session is changing, or null when it stops. */
  mark(businessId: string, topic: string, sessionId: string, field: string | null): boolean {
    const seat = this.#seat(businessId, topic, sessionId);
    if (seat === undefined || seat.session.side !== 'staff') return false;
    if (seat.field === field) return true;
    seat.field = field;
    this.#announce(businessId, topic, seat);
    return true;
  }

  /** Who else a joined staff session sees on `topic`: one entry a person. */
  seenBy(businessId: string, topic: string, sessionId: string): readonly PresenceView[] {
    const viewer = this.#seat(businessId, topic, sessionId);
    if (viewer === undefined || viewer.session.side !== 'staff') return [];
    const people = new Map<string, PresenceView>();
    for (const { session, field } of this.#businesses.get(businessId)?.get(topic)?.values() ?? []) {
      if (session.side !== 'staff' || session.personId === viewer.session.personId) continue;
      const known = people.get(session.personId);
      if (known !== undefined && (known.state === 'changing' || field === null)) continue;
      people.set(session.personId, {
        personId: session.personId,
        name: session.name,
        state: field === null ? 'viewing' : 'changing',
        field,
      });
    }
    return [...people.values()];
  }

  /**
   * Every business, topic and seat kept, for the proof that a leaving keeps
   * nothing: an emptied topic left behind would be a record of what was viewed.
   */
  get held(): number {
    let count = this.#businesses.size;
    for (const topics of this.#businesses.values()) {
      count += topics.size;
      for (const seats of topics.values()) count += seats.size;
    }
    return count;
  }

  #seat(businessId: string, topic: string, sessionId: string): Seat | undefined {
    return this.#businesses.get(businessId)?.get(topic)?.get(sessionId);
  }

  #announce(businessId: string, topic: string, seat: Seat): void {
    if (seat.session.side === 'staff') this.#changed(businessId, topic);
  }
}
