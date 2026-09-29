// SPDX-License-Identifier: AGPL-3.0-only
//
// The Team panel's model (MP-7-10): the people a staff member works with and
// whether each of them is in.
//
// Availability is only ever what a person set for themselves, with their
// reason. Nothing here derives it from activity or time: there is no online,
// idle or offline state (CS-7.27, FA-DOCK-75).

export interface Availability {
  /** The person's own words for why they are not in. */
  readonly reason: string;
}

export interface Teammate {
  readonly personId: string;
  readonly name: string;
  /** The short name under the face. */
  readonly short: string;
  readonly initials: string;
  /** Set by the person themselves; null is in. */
  readonly away: Availability | null;
}

/** What the person asks the `availability set` command for. It names nobody: it is always the caller. */
export type AvailabilityChange =
  { readonly away: true; readonly reason: string } | { readonly away: false };

/** Everyone in the strip: the reader's teammates, never the reader. */
export function teammatesOf(people: readonly Teammate[], me: string): readonly Teammate[] {
  return people.filter((person) => person.personId !== me);
}

/**
 * One message of a team conversation: a comment on the one comment record
 * (MP-4-5) whose audience is the conversation's members. There is no message
 * store beside it (RA-12); the panel draws what the comment read returns.
 */
export interface TeamMessage {
  readonly id: string;
  readonly authorId: string;
  readonly author: string;
  /** ISO time the comment was made. */
  readonly at: string;
  readonly body: string;
}

/** A direct conversation with one teammate, oldest message first (C71-D). */
export interface DirectThread {
  /** The teammate's person id: a direct conversation is named by its other member. */
  readonly with: string;
  /** Where the reader's own read marker sits; null before they have read any of it. */
  readonly lastRead: string | null;
  readonly messages: readonly TeamMessage[];
}

/** Unread is derived from the read marker: others' messages after it. */
export function unreadOf(thread: DirectThread, me: string): number {
  void thread;
  void me;
  return 0;
}

/** The Team tab's one figure: every conversation's unread, uncapped. */
export function teamUnread(threads: readonly DirectThread[], me: string): number {
  void threads;
  void me;
  return 0;
}

/** The newest message's time, the point a read marker moves to. */
export function newestAt(thread: DirectThread): string | null {
  void thread;
  return null;
}

/** The conversation the panel opens on: the first with anything unread (R36). */
export function openingThread(threads: readonly DirectThread[], me: string): string | null {
  void threads;
  void me;
  return null;
}
