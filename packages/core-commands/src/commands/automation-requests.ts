// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers' two requests (C33), one member each of
// `CommandRequest`; split from `requests.ts` for the per-file cap. Every value
// but the identifiers is unknown here: `automations.ts` checks each one and
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

export type AutomationRequest<E> = (ActivationChangeRequest & E) | (DefinitionReleaseRequest & E);
