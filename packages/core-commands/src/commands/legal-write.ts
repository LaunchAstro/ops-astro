// SPDX-License-Identifier: AGPL-3.0-only
//
// The legal documents (C81), three tracked actions under `privacy:manage`:
// `legal.draft_version` (`legal document version drafted`),
// `legal.approve_version` (`legal document version approved`) and
// `legal.publish_version` (`legal document published`).
//
// Approval names the bytes the approver read, as their SHA-256, and publishing
// takes only a version whose approval was of those bytes (standing gate 5). A
// version's words are never changed: redrafting a version is refused, and a
// change is a new version.
//
// A refusal names the field alone and never repeats the words, and the applied
// detail carries the version's id and digest only: an unpublished draft is
// the business's own until it is published.

import {
  approveLegalVersion,
  draftLegalVersion,
  LEGAL_DOCUMENTS,
  publishLegalVersion,
} from '../../../core-records/src/index.ts';
import type {
  LegalDocument,
  TenantQuery,
  VersionRefusal,
} from '../../../core-records/src/index.ts';
import type { CommandContext } from './context.ts';
import { applied, refused, type HandlerOutcome } from './outcome.ts';
import { refuseCommand, refuseNotFound } from './refusal.ts';
import type { CommandRequest } from './requests.ts';

type Draft = CommandRequest & { readonly command: 'legal.draft_version' };
type Approve = CommandRequest & { readonly command: 'legal.approve_version' };
type Publish = CommandRequest & { readonly command: 'legal.publish_version' };

const MAX_BODY = 200_000;

const FIXES: Readonly<Record<string, readonly string[]>> = {
  document: [`Send one of: ${LEGAL_DOCUMENTS.join(', ')}.`],
  version: ['Send the version as major.minor, such as 1.0.'],
  body: [`Send the document's words, 1 to ${String(MAX_BODY)} characters.`],
  digest: ["Send the SHA-256 of the version's words as 64 lowercase hex digits."],
};

const STATE_FIXES: Readonly<Record<Exclude<VersionRefusal, 'not-found'>, readonly string[]>> = {
  'digest-mismatch': ['Read the version again and approve the words it holds.'],
  'already-approved': ['Publish it, or draft a new version for a change.'],
  'not-approved': ['Approve this exact version first.'],
  'already-published': ['Draft a new version for a change.'],
};

const CODES = {
  'digest-mismatch': 'LEGAL_DIGEST_MISMATCH',
  'already-approved': 'LEGAL_ALREADY_APPROVED',
  'not-approved': 'LEGAL_NOT_APPROVED',
  'already-published': 'LEGAL_ALREADY_PUBLISHED',
} as const;

const DOCUMENTS: ReadonlySet<string> = new Set(LEGAL_DOCUMENTS);

const invalid = (field: string) =>
  refused(refuseCommand('FIELD_VALUE_INVALID', [field], FIXES[field] ?? []));

function refusedFor(refusal: VersionRefusal): HandlerOutcome {
  if (refusal === 'not-found') return refused(refuseNotFound());
  return refused(refuseCommand(CODES[refusal], [], STATE_FIXES[refusal]));
}

export async function draftVersion(
  tx: TenantQuery,
  context: CommandContext,
  request: Draft,
): Promise<HandlerOutcome> {
  const { document, version, body } = request;
  if (typeof document !== 'string' || !DOCUMENTS.has(document)) return invalid('document');
  if (typeof version !== 'string' || !/^\d{1,3}\.\d{1,3}$/u.test(version)) {
    return invalid('version');
  }
  if (typeof body !== 'string' || body.trim().length === 0 || body.length > MAX_BODY) {
    return invalid('body');
  }
  const drafted = await draftLegalVersion(
    tx,
    { document: document as LegalDocument, version, body },
    context.session.actorId,
  );
  if (drafted === undefined) {
    return refused(
      refuseCommand('LEGAL_VERSION_EXISTS', ['version'], ['Draft the change as a new version.']),
    );
  }
  return applied(drafted.id, null, { versionId: drafted.id, digest: drafted.digest });
}

export async function approveVersion(
  tx: TenantQuery,
  context: CommandContext,
  request: Approve,
): Promise<HandlerOutcome> {
  const { versionId, digest } = request;
  if (typeof versionId !== 'string') return refused(refuseNotFound());
  if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/u.test(digest)) return invalid('digest');
  const refusal = await approveLegalVersion(tx, versionId, digest, context.session.actorId);
  if (refusal !== undefined) return refusedFor(refusal);
  return applied(versionId, null, { versionId, digest });
}

export async function publishVersion(
  tx: TenantQuery,
  context: CommandContext,
  request: Publish,
): Promise<HandlerOutcome> {
  const { versionId } = request;
  if (typeof versionId !== 'string') return refused(refuseNotFound());
  const refusal = await publishLegalVersion(tx, versionId, context.session.actorId);
  if (refusal !== undefined) return refusedFor(refusal);
  return applied(versionId, null, { versionId });
}
