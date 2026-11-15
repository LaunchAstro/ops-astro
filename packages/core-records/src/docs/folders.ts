// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs piece 4a (#2514; migration 20261115104000): a folder renamed or moved inside its business.
//
// A rename locks its folder's row. A move locks every folder row of the business in id order and
// only then reads the tree, so two crossing moves (A under B, B under A) wait on each other and
// the second reads the first's parent: a folder never lands under itself or one of its own
// subfolders. Each asks the caller's `docs:write` again once its rows are held (`writeStands`).
// One name per parent, whatever its case, is the unique index's rule: the update runs in a
// savepoint, and that index's refusal is `taken`, so a rename racing a create of the same name
// ends in one folder and a refusal, never a fault.

import type { TenantQuery, TransactionQuery } from '../tenancy/transaction.ts';
import { isUuid } from '../tenancy/ids.ts';
import { writeStands, type DocsWriter } from './store.ts';

type Lost = { readonly kind: 'not-granted' };
type Written = { readonly kind: 'done' } | { readonly kind: 'taken' };

const ONE_NAME = 'docs_folders_one_name';
const RENAME = 'update public.docs_folders set name = $3 where business_id = $1 and id = $2';
const MOVE =
  'update public.docs_folders set parent_id = $3::uuid where business_id = $1 and id = $2';

/** The handler's transaction is the store's: its savepoint keeps a name refusal from failing it. */
function asTransaction(tx: TenantQuery): TransactionQuery {
  const held = tx as Partial<TransactionQuery>;
  if (typeof held.savepoint !== 'function')
    throw new Error('a docs folder write needs a savepoint');
  return tx as TransactionQuery;
}

/** One folder update in a savepoint of its own: `taken` on the one-name index, else thrown. */
async function written(tx: TenantQuery, sql: string, values: readonly unknown[]): Promise<Written> {
  let fault: unknown;
  const done = await asTransaction(tx).savepoint(async (inner) => {
    try {
      await inner.query(sql, [inner.businessId, ...values]);
    } catch (error) {
      fault = error;
      throw error;
    }
  });
  if (done) return { kind: 'done' };
  const named = (fault as { readonly constraint_name?: unknown } | undefined)?.constraint_name;
  if (named === ONE_NAME) return { kind: 'taken' };
  throw fault ?? new Error('docs folder write failed');
}

export async function renameDocsFolder(
  tx: TenantQuery,
  writer: DocsWriter,
  input: { readonly folderId: string; readonly name: string },
): Promise<Written | { readonly kind: 'no-folder' } | Lost> {
  if (!isUuid(input.folderId)) return { kind: 'no-folder' };
  const id = input.folderId.toLowerCase();
  const rows = await tx.query<{ readonly id: string }>(
    'select id from public.docs_folders where business_id = $1 and id = $2 for update',
    [tx.businessId, id],
  );
  if (rows.length === 0) return { kind: 'no-folder' };
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  return await written(tx, RENAME, [id, input.name]);
}

/** True when `parentId` is `folderId` or sits anywhere under it in `parents`. */
function under(parents: ReadonlyMap<string, string | null>, folderId: string, parentId: string) {
  const seen = new Set<string>();
  for (let at: string | null = parentId; at !== null; at = parents.get(at) ?? null) {
    if (at === folderId) return true;
    if (seen.has(at)) return true;
    seen.add(at);
  }
  return false;
}

export async function moveDocsFolder(
  tx: TenantQuery,
  writer: DocsWriter,
  input: { readonly folderId: string; readonly parentId: string | null },
): Promise<
  | Written
  | { readonly kind: 'no-folder' }
  | { readonly kind: 'no-parent' }
  | { readonly kind: 'cycle' }
  | Lost
> {
  if (!isUuid(input.folderId)) return { kind: 'no-folder' };
  if (input.parentId !== null && !isUuid(input.parentId)) return { kind: 'no-parent' };
  const id = input.folderId.toLowerCase();
  const parentId = input.parentId?.toLowerCase() ?? null;
  // The tree lock: every folder of the business, in one order, read only once it is held.
  const rows = await tx.query<{ readonly id: string; readonly parent_id: string | null }>(
    'select id, parent_id from public.docs_folders where business_id = $1 order by id for update',
    [tx.businessId],
  );
  const parents = new Map(rows.map((row) => [row.id, row.parent_id]));
  if (!parents.has(id)) return { kind: 'no-folder' };
  if (parentId !== null && !parents.has(parentId)) return { kind: 'no-parent' };
  if (!(await writeStands(tx, writer.subjects))) return { kind: 'not-granted' };
  if (parentId !== null && under(parents, id, parentId)) return { kind: 'cycle' };
  return await written(tx, MOVE, [id, parentId]);
}
