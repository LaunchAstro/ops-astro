// SPDX-License-Identifier: AGPL-3.0-only
//
// The two C33 requests, as the envelope hands them to `automations.ts`. Every
// value but the identifiers is unknown here: the command checks each one and
// names the field it refuses.

// Type aliases, not interfaces: the envelope reads a request as a record of
// fields, which an interface's closed shape would not be.
export type ActivationChangeRequest = {
  readonly command: 'activation.change';
  readonly activationId?: string;
  readonly versionId: string;
  readonly mode?: unknown;
  readonly everyMinutes?: unknown;
  readonly eventKind?: unknown;
  readonly enabled?: unknown;
  readonly expectedRevision?: unknown;
};

export type DefinitionReleaseRequest = {
  readonly command: 'definition.release';
  readonly definitionId?: string;
  readonly name?: unknown;
  readonly kind?: unknown;
  readonly contentDigest?: unknown;
  readonly contentSize?: unknown;
  readonly inputs?: unknown;
  readonly operations?: unknown;
  readonly modes?: unknown;
};
