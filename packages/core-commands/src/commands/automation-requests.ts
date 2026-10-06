// SPDX-License-Identifier: AGPL-3.0-only
//
// Settings ▸ Workflow triggers' requests (C33, C52-A), one member each of
// `CommandRequest`; split from `requests.ts` for the per-file cap. Every value
// but the identifiers is unknown here: `automations.ts` and
// `automation-approvals.ts` check each one and name the field they refuse.

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

export type ActivationAdoptRequest = {
  readonly command: 'activation.adopt';
  readonly activationId: string;
  readonly versionId: string;
  readonly expectedRevision?: unknown;
};

export type ActivationRollBackRequest = {
  readonly command: 'activation.roll_back';
  readonly activationId: string;
  readonly expectedRevision?: unknown;
};

export type ActivationTurnOffRequest = {
  readonly command: 'activation.turn_off';
  readonly activationId: string;
  readonly expectedRevision?: unknown;
};

export type ApprovalRevokeRequest = {
  readonly command: 'approval.revoke';
  readonly approvalId: string;
};

export type AutomationRequest<E> =
  | (ActivationChangeRequest & E)
  | (DefinitionReleaseRequest & E)
  | (ActivationAdoptRequest & E)
  | (ActivationRollBackRequest & E)
  | (ActivationTurnOffRequest & E)
  | (ApprovalRevokeRequest & E);
