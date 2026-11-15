// SPDX-License-Identifier: AGPL-3.0-only
//
// The matrix's Docs bodies (#2493): the admin files its own folder and page first, each under a
// fresh name, so a recipe run twice never meets its first run's rows.

import { randomUUID } from 'node:crypto';
import type { CommandName } from '../../packages/core-wire/src/surface.ts';

interface DocsContext {
  asPerson(
    name: CommandName,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly code: string; readonly body: Record<string, unknown> }>;
}

type Prepared = { readonly body: Record<string, unknown> };

const fresh = (what: string): string => `${what} ${randomUUID().slice(0, 8)}`;

async function filed(context: DocsContext, name: CommandName, body: Record<string, unknown>) {
  const made = await context.asPerson(name, body);
  if (made.code !== 'ok') throw new Error(`matrix: ${name} refused ${made.code}`);
  return made.body['detail'] as Record<string, unknown>;
}

/** The admin's body for one Docs command, or undefined for any other name. */
export async function docsBody(
  name: CommandName,
  context: DocsContext,
): Promise<Prepared | undefined> {
  if (name === 'docs.create_folder') return { body: { name: fresh('folder') } };
  if (name !== 'docs.create_page' && name !== 'docs.update_page') return undefined;
  const { folderId } = await filed(context, 'docs.create_folder', { name: fresh('folder') });
  if (name === 'docs.create_page')
    return { body: { folderId, title: fresh('page'), body: 'text' } };
  const { pageId } = await filed(context, 'docs.create_page', {
    folderId,
    title: fresh('page'),
    body: 'text',
  });
  return { body: { pageId, expectedVersion: 1, body: 'revised' } };
}

/** A folder and a page of another business's (#2493), for the identifier cases. */
export async function seedForeignDocs(
  admin: { execute(sql: string, values: readonly unknown[]): Promise<unknown> },
  business: string,
  by: { readonly actorId: string | null },
): Promise<{ readonly folderId: string; readonly pageId: string }> {
  const folderId = randomUUID();
  const pageId = randomUUID();
  await admin.execute(
    `insert into public.docs_folders (business_id, id, name, created_by_actor_id)
     values ($1, $2, $3, $4)`,
    [business, folderId, fresh('foreign'), by.actorId],
  );
  await admin.execute(
    `insert into public.docs_pages
       (business_id, id, folder_id, title, body, version, created_by_actor_id, updated_by_actor_id)
     values ($1, $2, $3, 'foreign', 'foreign', 1, $4, $4)`,
    [business, pageId, folderId, by.actorId],
  );
  return { folderId, pageId };
}
