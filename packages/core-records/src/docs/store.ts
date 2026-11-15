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
// two saves from one version leave one and the other is told the page moved on. A page's move to
// another folder of the business (#2514) is such an update; folder renames and moves are in
// `folders.ts`.

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
// A split character (an unpaired surrogate; with `u` a paired one is one code point and does not
// match), which the text writer would store as U+FFFD, text nobody sent (`storableText`'s rule).
const SPLIT = /[\uD800-\uDFFF]/u;

function lineOf(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.trim();
  if (line.length === 0 || line.length > limit || CONTROL.test(line)) return undefined;
  if (SPLIT.test(line)) return undefined;
  return line;
}

/** A folder name a person meant: trimmed, 1 to 120 characters, no control or split character. */
export const docsNameOf = (value: unknown): string | undefined => lineOf(value, DOCS_NAME_LIMIT);
/** A page title: trimmed, 1 to 200 characters, no control or split character. */
export const docsTitleOf = (value: unknown): string | undefined => lineOf(value, DOCS_TITLE_LIMIT);

/** A Markdown body as sent: up to 200,000 characters, no NUL (Postgres keeps none), no split character. */
export function docsBodyOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > DOCS_BODY_LIMIT || value.includes('\u0000')) {
    return undefined;
  }
  if (SPLIT.test(value)) return undefined;
  return value;
}

type Lost = { readonly kind: 'not-granted' };

const docsWrite = (subjects: readonly Subject[]): Covering => ({
  subjects,
  collection: DOCS_COLLECTION,
  action: 'write',
});

/** The caller's `docs:write` held for the transaction and asked again now, at business scope. */
export async function writeStands(tx: TenantQuery, subjects: readonly Subject[]): Promise<boolean> {
  const covering = docsWrite(subjects);
  await holdCoveringGrants(tx, covering);
  return await coveredAt(tx, covering, null);
}

async function folderHere(tx: TenantQuery, folderId: string): Promise<boolean> {
  if (!isUuid(folderId)) return false;
  // No row lock: no folder is ever deleted, and the insert's foreign key key-share locks the
  // folder it names, so one read here is still there at the insert. A folder moved meanwhile
  // (#2514) is still the business's, and a new folder or page under it makes no cycle.
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

/** A page's new title, body, folder and version, and the version row that records it. */
async function savePage(
  tx: TenantQuery,
  next: Parameters<typeof appendVersion>[1],
  folderId: string,
  actorId: string,
): Promise<void> {
  await tx.query(
    `update public.docs_pages
        set title = $3, body = $4, version = $5, updated_by_actor_id = $6, updated_at = now(),
            folder_id = $7::uuid
      where business_id = $1 and id = $2`,
    [tx.businessId, next.id, next.title, next.body, next.number, actorId, folderId],
  );
  await appendVersion(tx, next, actorId);
}

export async function updateDocsPage(
  tx: TenantQuery,
  writer: DocsWriter,
  input: {
    readonly pageId: string;
    readonly expectedVersion: number;
    readonly title: string | undefined;
    readonly body: string | undefined;
    /** A move (#2514): the folder the page goes to, in this business. */
    readonly folderId?: string | undefined;
  },
): Promise<
  | { readonly kind: 'updated'; readonly version: number }
  | { readonly kind: 'no-page' }
  | { readonly kind: 'no-folder' }
  | { readonly kind: 'stale'; readonly version: number }
  | Lost
> {
  if (!isUuid(input.pageId)) return { kind: 'no-page' };
  const [page] = await tx.query<{
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly folder_id: string;
    readonly version: number;
  }>(
    `select id, title, body, folder_id, version from public.docs_pages where business_id = $1 and id = $2 for update`,
    [tx.businessId, input.pageId.toLowerCase()],
  );
  if (page === undefined) return { kind: 'no-page' };
  const moving = input.folderId;
  if (moving !== undefined && !(await folderHere(tx, moving))) return { kind: 'no-folder' };
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  if (page.version !== input.expectedVersion) return { kind: 'stale', version: page.version };
  const next = {
    id: page.id,
    number: page.version + 1,
    title: input.title ?? page.title,
    body: input.body ?? page.body,
  };
  await savePage(tx, next, moving?.toLowerCase() ?? page.folder_id, writer.actorId);
  return { kind: 'updated', version: next.number };
}

/** A folder in the tree: its parent folder, or none at the top. */
export interface DocsFolderRow {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
}

/** A page in the tree: its folder, title and version, never its body. */
export interface DocsPageEntry {
  readonly id: string;
  readonly folderId: string;
  readonly title: string;
  readonly version: number;
}

/** One page as a reader opens it: the Markdown body and the version a save starts from. */
export interface DocsPageRow extends DocsPageEntry {
  readonly body: string;
  readonly updatedAt: string;
}

/** The business's folders and page titles (#2493 piece 2), by name, filtered to the business. */
export async function readDocsTree(
  tx: TenantQuery,
): Promise<{ readonly folders: DocsFolderRow[]; readonly pages: DocsPageEntry[] }> {
  const folders = await tx.query<DocsFolderRow>(
    `select id::text as "id", name, parent_id::text as "parentId"
       from public.docs_folders where business_id = $1 order by lower(name), id`,
    [tx.businessId],
  );
  const pages = await tx.query<DocsPageEntry>(
    `select id::text as "id", folder_id::text as "folderId", title, version
       from public.docs_pages where business_id = $1 order by lower(title), id`,
    [tx.businessId],
  );
  return {
    folders: folders.map(({ id, name, parentId }) => ({ id, name, parentId })),
    pages: pages.map(({ id, folderId, title, version }) => ({ id, folderId, title, version })),
  };
}

/** One page of the business, or undefined for one that is missing or another business's. */
export async function readDocsPage(
  tx: TenantQuery,
  pageId: string,
): Promise<DocsPageRow | undefined> {
  if (!isUuid(pageId)) return undefined;
  const [row] = await tx.query<{
    readonly id: string;
    readonly folderId: string;
    readonly title: string;
    readonly body: string;
    readonly version: number;
    readonly updatedAt: Date;
  }>(
    `select id::text as "id", folder_id::text as "folderId", title, body, version,
            updated_at as "updatedAt"
       from public.docs_pages where business_id = $1 and id = $2`,
    [tx.businessId, pageId.toLowerCase()],
  );
  if (row === undefined) return undefined;
  const { id, folderId, title, body, version, updatedAt } = row;
  return { id, folderId, title, body, version, updatedAt: new Date(updatedAt).toISOString() };
}
