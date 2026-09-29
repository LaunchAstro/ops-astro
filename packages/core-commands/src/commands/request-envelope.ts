// SPDX-License-Identifier: AGPL-3.0-only
//
// What every command request carries, apart from its own fields: shared by
// `requests.ts` and its conversation part, so neither imports the other.

// A type alias rather than an interface, so each member of the request union
// is also an `UncheckedRequest`: a parsed request is still the body it was
// parsed from.
export type Envelope = {
  /** The repeat-request identity. Required on every command in the surface. */
  readonly operationId: string;
};
