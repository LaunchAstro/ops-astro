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
  void me;
  return people;
}
