// SPDX-License-Identifier: AGPL-3.0-only
//
// The request shapes of the privacy records (C55), the legal documents and
// their registers (C81), the agent credential (API-2) and the first-client
// gate's own acts (S0-5), split from `requests.ts` to keep it under the line
// limit. `E` is that file's envelope, passed in rather than imported, so the
// two files do not import each other.

export type PrivacyRequest<E> =
  // C55: a privacy incident record's day-0 facts, each checked by the handler
  // in its own words (`privacy-write.ts`), so every field is `unknown` here.
  | ({
      readonly command: 'privacy.record_incident';
      readonly whatHappened: unknown;
      readonly foundAt: unknown;
      readonly foundBy: unknown;
      readonly affected: unknown;
      readonly informationKinds: unknown;
    } & E)
  // C81: a legal document's version. The draft's fields and the approval's
  // digest are checked by the handler in its own words (`legal-write.ts`).
  | ({
      readonly command: 'legal.draft_version';
      readonly document: unknown;
      readonly version: unknown;
      readonly body: unknown;
    } & E)
  | ({
      readonly command: 'legal.approve_version';
      readonly versionId: string;
      readonly digest: unknown;
    } & E)
  | ({ readonly command: 'legal.publish_version'; readonly versionId: string } & E)
  // API-2: an agent credential. The scope, the expiry and the purpose are
  // checked by the handler in its own words (`credential-write.ts`).
  | ({
      readonly command: 'credential.issue';
      readonly scope: unknown;
      readonly expiresAt: unknown;
      readonly purpose: unknown;
    } & E)
  | ({ readonly command: 'credential.revoke'; readonly credentialId: string } & E)
  // C81: one row of the overseas-services register, every field checked by the
  // handler in its own words (`overseas-write.ts`).
  | ({
      readonly command: 'privacy.set_overseas_service';
      readonly service: unknown;
      readonly receives: unknown;
      readonly where: unknown;
      readonly trainsOnIt: unknown;
      readonly contract: unknown;
      readonly toConfirm: unknown;
      readonly inUse: unknown;
    } & E)
  // C81: one row of the data-class register, every field checked by the
  // handler in its own words (`data-class-write.ts`).
  | ({
      readonly command: 'privacy.set_data_class';
      readonly dataClass: unknown;
      readonly purpose: unknown;
      readonly disclosures: unknown;
      readonly retention: unknown;
      readonly deletion: unknown;
      readonly inUse: unknown;
    } & E)
  // S0-5: the first-client gate's own acts, every field checked by the
  // handler in its own words (`gate-write.ts`).
  | ({
      readonly command: 'operations.record_gate_item';
      readonly item: unknown;
      readonly evidence: unknown;
      readonly statement?: unknown;
    } & E)
  | ({ readonly command: 'operations.change_installation_mode'; readonly mode: unknown } & E);
