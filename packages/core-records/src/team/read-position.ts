// SPDX-License-Identifier: AGPL-3.0-only
//
// A read position (C71-D): how `chat.messages` writes a message's `at`, and
// how `chat.mark_read` reads it back as its `upTo`.

/**
 * The newest message a reader saw, as `chat.messages` showed it: its
 * millisecond and how many of that millisecond's messages the reading held.
 */
export interface ReadPosition {
  readonly at: Date;
  readonly seen: number;
}

/**
 * A message's `at` as one reading shows it: its millisecond, and when the
 * reading holds n > 1 of that millisecond's messages, n in the microsecond
 * digits. Sent back as `upTo`, it covers the n the reader saw and none later.
 */
export function shownAt(at: Date, tied: number): string {
  const text = at.toISOString();
  return tied > 1 ? `${text.slice(0, -1)}${String(tied).padStart(3, '0')}Z` : text;
}

/** `upTo` as `shownAt` writes it, or undefined when it is not such a time. */
export function readPositionOf(upTo: unknown): ReadPosition | undefined {
  if (typeof upTo !== 'string') return undefined;
  const tied = /(\.\d{3})(\d{3})Z$/u.exec(upTo);
  const at = new Date(tied === null ? upTo : `${upTo.slice(0, tied.index)}${tied[1]}Z`);
  if (Number.isNaN(at.getTime())) return undefined;
  return { at, seen: Math.max(1, Number(tied?.[2] ?? 1)) };
}
