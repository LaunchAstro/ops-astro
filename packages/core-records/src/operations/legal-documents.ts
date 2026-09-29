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
//
// The privacy policy reads the overseas-services register (migration 0035): a
// policy version is drafted with the rows in use and their digest, and
// approving or publishing it is refused while any of them is to confirm or
// once the register has moved since the draft. Each takes the register's lock
// before reading it (`overseas-services.ts`), after the version's row lock;
// setting a row takes the register's lock alone, so the two never wait on
// each other in a cycle.

import { randomUUID } from 'node:crypto';
import type { TenantQuery } from '../tenancy/database.ts';
import { lockRegister, readRegister, type ListedService } from './overseas-services.ts';

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
  /** The privacy policy's services, from the register as it was drafted. */
  readonly services?: readonly ListedService[];
}

/** Why a version could not be approved or published, or `undefined` when it was. */
export type VersionRefusal =
  | 'not-found'
  | 'digest-mismatch'
  | 'already-approved'
  | 'not-approved'
  | 'already-published'
  | 'register-changed'
  | 'register-unconfirmed';

interface LockedRow {
  readonly document: LegalDocument;
  readonly register_digest: string | null;
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
  let register: { readonly listed: string; readonly digest: string } | undefined;
  if (draft.document === 'privacy-policy') {
    await lockRegister(tx);
    const state = await readRegister(tx);
    register = { listed: JSON.stringify(state.listed), digest: state.digest };
  }
  const rows = await tx.query<{ readonly id: string; readonly body_digest: string }>(
    `insert into public.legal_document_versions
       (business_id, id, document, version, body, body_digest, drafted_by_actor,
        register, register_digest)
     values ($1, $2, $3, $4, $5, '', $6, $7::text::jsonb, $8)
     on conflict (business_id, document, version) do nothing
     returning id, body_digest`,
    [
      tx.businessId,
      randomUUID(),
      draft.document,
      draft.version,
      draft.body,
      actorId,
      register?.listed ?? null,
      register?.digest ?? null,
    ],
  );
  const row = rows[0];
  return row === undefined ? undefined : { id: row.id, digest: row.body_digest };
}

async function lockVersion(tx: TenantQuery, versionId: string): Promise<LockedRow | undefined> {
  const rows = await tx.query<LockedRow>(
    `select document, register_digest, body_digest, approved_at, published_at
       from public.legal_document_versions
      where business_id = $1 and id = $2
      for update`,
    [tx.businessId, versionId],
  );
  return rows[0];
}

/**
 * For a privacy policy, under the register's lock: refused while the register
 * has moved since the draft or holds a row to confirm. Other documents pass.
 */
async function registerRefusal(
  tx: TenantQuery,
  row: LockedRow,
): Promise<VersionRefusal | undefined> {
  if (row.document !== 'privacy-policy') return undefined;
  await lockRegister(tx);
  const state = await readRegister(tx);
  if (state.digest !== row.register_digest) return 'register-changed';
  return state.unconfirmed ? 'register-unconfirmed' : undefined;
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
  const register = await registerRefusal(tx, row);
  if (register !== undefined) return register;
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
  const register = await registerRefusal(tx, row);
  if (register !== undefined) return register;
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
    readonly register: readonly ListedService[] | null;
  }>(
    `select version, body, body_digest, published_at, register
       from public.legal_document_versions
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
        ...(row.register === null ? {} : { services: row.register }),
      };
}
