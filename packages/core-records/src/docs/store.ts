// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs store (#2493 piece 1; migration 20261115002300): a business's folder tree, its pages
// as Markdown text, and one version row for every write.
//
// Every statement is filtered by the business the session set, on top of the tables' forced row
// security, so an identifier from another business is a folder or page that is not here. Docs are
// the business's own: the write's grant is asked at business scope (`coveredAt` with no party),
// so a grant held at one client covers none of it.
//
// Each write holds the caller's `docs:write` grants (`holdCoveringGrants`) and asks them again
// at the statement's own instant once its rows are locked: a grant revoked or expired while the
// write waited covers nothing. An update locks its page, then compares the version it read, so
// two saves from one version leave one and the other is told the page moved on.

import { randomUUID } from 'node:crypto';
import type { Subject } from '../authority/grants.ts';
import { coveredAt, holdCoveringGrants, type Covering } from '../site/covering.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import { isUuid } from '../tenancy/ids.ts';

export const DOCS_COLLECTION = 'docs';
/** The longest folder name and page title 20261115002300 keeps, and the longest body. */
export const DOCS_NAME_LIMIT = 120;
export const DOCS_TITLE_LIMIT = 200;
export const DOCS_BODY_LIMIT = 200_000;

// oxlint-disable-next-line no-control-regex -- control characters are what it refuses
const CONTROL = /[\u0000-\u001F\u007F]/u;

function lineOf(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.trim();
  if (line.length === 0 || line.length > limit || CONTROL.test(line)) return undefined;
  return line;
}

/** A folder name a person meant: trimmed, 1 to 120 characters, no control character. */
export const docsNameOf = (value: unknown): string | undefined => lineOf(value, DOCS_NAME_LIMIT);
/** A page title: trimmed, 1 to 200 characters, no control character. */
export const docsTitleOf = (value: unknown): string | undefined => lineOf(value, DOCS_TITLE_LIMIT);

/** A Markdown body as sent: text up to 200,000 characters, with no NUL (Postgres keeps none). */
export function docsBodyOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > DOCS_BODY_LIMIT || value.includes('\u0000')) {
    return undefined;
  }
  return value;
}

type Lost = { readonly kind: 'not-granted' };

const docsWrite = (subjects: readonly Subject[]): Covering => ({
  subjects,
  collection: DOCS_COLLECTION,
  action: 'write',
});

/** The caller's `docs:write` held for the transaction and asked again now, at business scope. */
async function writeStands(tx: TenantQuery, subjects: readonly Subject[]): Promise<boolean> {
  const covering = docsWrite(subjects);
  await holdCoveringGrants(tx, covering);
  return await coveredAt(tx, covering, null);
}

async function folderHere(tx: TenantQuery, folderId: string): Promise<boolean> {
  if (!isUuid(folderId)) return false;
  // No row lock: the app role may not delete or move a folder, and the insert's foreign key
  // key-share locks the folder it names, so one read here is still there at the insert.
  const rows = await tx.query<{ readonly id: string }>(
    'select id from public.docs_folders where business_id = $1 and id = $2::uuid',
    [tx.businessId, folderId],
  );
  return rows.length > 0;
}

export interface DocsWriter {
  readonly actorId: string;
  readonly subjects: readonly Subject[];
}

export async function createDocsFolder(
  tx: TenantQuery,
  writer: DocsWriter,
  input: { readonly name: string; readonly parentId: string | null },
): Promise<
  | { readonly kind: 'created'; readonly folderId: string }
  | { readonly kind: 'no-parent' }
  | { readonly kind: 'taken' }
  | Lost
> {
  if (input.parentId !== null && !(await folderHere(tx, input.parentId))) {
    return { kind: 'no-parent' };
  }
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  const rows = await tx.query<{ readonly id: string }>(
    `insert into public.docs_folders (business_id, id, parent_id, name, created_by_actor_id)
     values ($1, $2, $3::uuid, $4, $5)
     on conflict (business_id, coalesce(parent_id, business_id), lower(name)) do nothing
     returning id`,
    [
      tx.businessId,
      randomUUID(),
      input.parentId?.toLowerCase() ?? null,
      input.name,
      writer.actorId,
    ],
  );
  const row = rows[0];
  return row === undefined ? { kind: 'taken' } : { kind: 'created', folderId: row.id };
}

async function appendVersion(
  tx: TenantQuery,
  page: {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly body: string;
  },
  actorId: string,
): Promise<void> {
  await tx.query(
    `insert into public.docs_page_versions (business_id, page_id, number, title, body, actor_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [tx.businessId, page.id, page.number, page.title, page.body, actorId],
  );
}

export async function createDocsPage(
  tx: TenantQuery,
  writer: DocsWriter,
  input: { readonly folderId: string; readonly title: string; readonly body: string },
): Promise<
  | { readonly kind: 'created'; readonly pageId: string; readonly version: 1 }
  | { readonly kind: 'no-folder' }
  | Lost
> {
  if (!(await folderHere(tx, input.folderId))) return { kind: 'no-folder' };
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  const id = randomUUID();
  await tx.query(
    `insert into public.docs_pages
       (business_id, id, folder_id, title, body, version, created_by_actor_id, updated_by_actor_id)
     values ($1, $2, $3::uuid, $4, $5, 1, $6, $6)`,
    [tx.businessId, id, input.folderId.toLowerCase(), input.title, input.body, writer.actorId],
  );
  await appendVersion(tx, { id, number: 1, title: input.title, body: input.body }, writer.actorId);
  return { kind: 'created', pageId: id, version: 1 };
}

export async function updateDocsPage(
  tx: TenantQuery,
  writer: DocsWriter,
  input: {
    readonly pageId: string;
    readonly expectedVersion: number;
    readonly title: string | undefined;
    readonly body: string | undefined;
  },
): Promise<
  | { readonly kind: 'updated'; readonly version: number }
  | { readonly kind: 'no-page' }
  | { readonly kind: 'stale'; readonly version: number }
  | Lost
> {
  if (!isUuid(input.pageId)) return { kind: 'no-page' };
  const [page] = await tx.query<{
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly version: number;
  }>(
    `select id, title, body, version from public.docs_pages where business_id = $1 and id = $2 for update`,
    [tx.businessId, input.pageId.toLowerCase()],
  );
  if (page === undefined) return { kind: 'no-page' };
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  if (page.version !== input.expectedVersion) return { kind: 'stale', version: page.version };
  const next = {
    id: page.id,
    number: page.version + 1,
    title: input.title ?? page.title,
    body: input.body ?? page.body,
  };
  await tx.query(
    `update public.docs_pages
        set title = $3, body = $4, version = $5, updated_by_actor_id = $6, updated_at = now()
      where business_id = $1 and id = $2`,
    [tx.businessId, page.id, next.title, next.body, next.number, writer.actorId],
  );
  await appendVersion(tx, next, writer.actorId);
  return { kind: 'updated', version: next.number };
}
