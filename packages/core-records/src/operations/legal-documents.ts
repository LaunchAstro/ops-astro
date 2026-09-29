// SPDX-License-Identifier: AGPL-3.0-only
//
// The legal documents (C81, migration 0034): each a run of versions, drafted,
// approved as those exact bytes and published. The table's guard keeps every
// version's words fixed once written, so a change is always a new version and
// a published one is never edited in place.
//
// Approving and publishing lock the version's row (`for update`) and decide
// from what is read under that lock, so an approval and a publication racing
// on one version apply in one order, each seeing the other's effect.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';

/** The documents a business keeps versions of, as the gate names them. */
export const LEGAL_DOCUMENTS = [
  'client-terms',
  'privacy-policy',
  'data-handling',
  'breach-runbook',
] as const;

export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** Read at a public address once published; the breach runbook is the operators' own. */
export const PUBLIC_LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  'client-terms',
  'privacy-policy',
  'data-handling',
];

export interface DraftedVersion {
  readonly id: string;
  readonly digest: string;
}

export interface PublishedVersion {
  readonly document: LegalDocument;
  readonly version: string;
  readonly body: string;
  readonly digest: string;
  readonly publishedAt: Date;
}

/** Why a version could not be approved or published, or `undefined` when it was. */
export type VersionRefusal =
  'not-found' | 'digest-mismatch' | 'already-approved' | 'not-approved' | 'already-published';

interface LockedRow {
  readonly body_digest: string;
  readonly approved_at: Date | null;
  readonly published_at: Date | null;
}

/**
 * Write a new version, or answer `undefined` when this document already has
 * that version: the label is taken, whatever its state.
 */
export async function draftLegalVersion(
  tx: TenantQuery,
  draft: { readonly document: LegalDocument; readonly version: string; readonly body: string },
  actorId: string,
): Promise<DraftedVersion | undefined> {
  const rows = await tx.query<{ readonly id: string; readonly body_digest: string }>(
    `insert into public.legal_document_versions
       (business_id, id, document, version, body, body_digest, drafted_by_actor)
     values ($1, $2, $3, $4, $5, '', $6)
     on conflict (business_id, document, version) do nothing
     returning id, body_digest`,
    [tx.businessId, randomUUID(), draft.document, draft.version, draft.body, actorId],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, digest: row.body_digest };
}

async function lockVersion(tx: TenantQuery, versionId: string): Promise<LockedRow | undefined> {
  const rows = await tx.query<LockedRow>(
    `select body_digest, approved_at, published_at from public.legal_document_versions
      where business_id = $1 and id = $2
      for update`,
    [tx.businessId, versionId],
  );
  return rows[0];
}

/** Approve the version whose bytes have `digest`, under the version's row lock. */
export async function approveLegalVersion(
  tx: TenantQuery,
  versionId: string,
  digest: string,
  actorId: string,
): Promise<VersionRefusal | undefined> {
  const row = await lockVersion(tx, versionId);
  if (row === undefined) return 'not-found';
  if (row.approved_at !== null) return 'already-approved';
  if (row.body_digest !== digest) return 'digest-mismatch';
  await tx.query(
    `update public.legal_document_versions
        set approved_at = now(), approved_by_actor = $3, approved_digest = body_digest
      where business_id = $1 and id = $2`,
    [tx.businessId, versionId, actorId],
  );
  return undefined;
}

/** Publish an approved version, under the version's row lock. */
export async function publishLegalVersion(
  tx: TenantQuery,
  versionId: string,
  actorId: string,
): Promise<VersionRefusal | undefined> {
  const row = await lockVersion(tx, versionId);
  if (row === undefined) return 'not-found';
  if (row.published_at !== null) return 'already-published';
  if (row.approved_at === null) return 'not-approved';
  await tx.query(
    `update public.legal_document_versions
        set published_at = now(), published_by_actor = $3
      where business_id = $1 and id = $2`,
    [tx.businessId, versionId, actorId],
  );
  return undefined;
}

/** The version of `document` published most recently, if any. */
export async function readPublishedLegal(
  tx: TenantQuery,
  document: LegalDocument,
): Promise<PublishedVersion | undefined> {
  const rows = await tx.query<{
    readonly version: string;
    readonly body: string;
    readonly body_digest: string;
    readonly published_at: Date;
  }>(
    `select version, body, body_digest, published_at from public.legal_document_versions
      where business_id = $1 and document = $2 and published_at is not null
      order by published_at desc, drafted_at desc
      limit 1`,
    [tx.businessId, document],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : {
        document,
        version: row.version,
        body: row.body,
        digest: row.body_digest,
        publishedAt: row.published_at,
      };
}
