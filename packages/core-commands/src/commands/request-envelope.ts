// SPDX-License-Identifier: AGPL-3.0-only
//
// What every command request carries, apart from its own fields: shared by
// `requests.ts`, its conversation part and `requests-wayfinder.ts`, so none
// imports another. Type aliases rather than interfaces, so each member of the
// union is also an `UncheckedRequest`: a parsed request is still the body it
// was parsed from.
export type Envelope = {
  /** The repeat-request identity. Required on every command in the surface. */
  readonly operationId: string;
};

export type Targeted = Envelope & {
  readonly recordId: string;
  readonly expectedRevision?: number;
};
