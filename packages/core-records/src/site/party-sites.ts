// SPDX-License-Identifier: AGPL-3.0-only
//
// Each client's site (C80): its repository, default branch and hosting
// project, and each page with its source file. The one place a party is
// mapped to its pages, read by a correction's request in its insert and by the
// runner for its binding. No command writes it: the operator's own script
// binds a site, under the business's tenancy, as an actor of that business.
//
// A site is bound once in the installation (its repository, in lower case,
// and its project id are unique across businesses), and a page names one
// client in its business. While a correction of the client is open, no page of
// its site is unbound and its providers do not change (the storage refuses,
// with the corrections share-locked so one being written is waited for).

import type { TenantQuery } from '../tenancy/database.ts';
import type { TransactionQuery } from '../tenancy/transaction.ts';

/** One client's site as the runner binds it: the shape `core-connectors` takes. */
export interface PartySiteRecord {
  readonly partyId: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

export type SiteWrite =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        | 'SITE_BOUND_ELSEWHERE'
        | 'PAGE_BOUND_ELSEWHERE'
        | 'SITE_UNDER_CORRECTION'
        | 'PAGE_UNDER_CORRECTION';
    };

const REFUSED_BY: Readonly<Record<string, Exclude<SiteWrite, { ok: true }>['code']>> = {
  party_sites_repository_key: 'SITE_BOUND_ELSEWHERE',
  party_sites_project_key: 'SITE_BOUND_ELSEWHERE',
  party_site_pages_pkey: 'PAGE_BOUND_ELSEWHERE',
  party_sites_held: 'SITE_UNDER_CORRECTION',
  party_site_pages_held: 'PAGE_UNDER_CORRECTION',
};

/** The storage's refusal by the constraint it names, or undefined for any other fault. */
function refusalOf(error: unknown): SiteWrite | undefined {
  const named = (error as { readonly constraint_name?: unknown } | null)?.constraint_name;
  const code = typeof named === 'string' ? REFUSED_BY[named] : undefined;
  return code === undefined ? undefined : { ok: false, code };
}

/** One write in a savepoint of its own, so a refusal leaves the caller's transaction going. */
async function held(
  tx: TransactionQuery,
  write: (inner: TenantQuery) => Promise<void>,
): Promise<SiteWrite> {
  let refusal: SiteWrite | undefined;
  const done = await tx.savepoint(async (inner) => {
    try {
      await write(inner);
    } catch (error) {
      refusal = refusalOf(error);
      throw error;
    }
  });
  if (done) return { ok: true };
  if (refusal === undefined) throw new Error('party site write failed');
  return refusal;
}

/**
 * Bind a client's site, or move its providers, and add each page not held yet.
 * A page the site holds already with the same file is left as it is; pages it
 * holds that are not named stay bound (unbinding is `unbindPartySitePage`).
 */
export async function bindPartySite(
  tx: TransactionQuery,
  site: PartySiteRecord,
  actorId: string,
): Promise<SiteWrite> {
  return await held(tx, async (inner) => {
    await inner.query(
      `insert into public.party_sites as s
         (business_id, party_id, repository, default_branch, project, changed_by_actor_id)
       values ($1, $2::uuid, $3, $4, $5, $6::uuid)
       on conflict (business_id, party_id) do update
         set repository = excluded.repository, default_branch = excluded.default_branch,
             project = excluded.project, changed_by_actor_id = excluded.changed_by_actor_id,
             changed_at = now(), revision = s.revision + 1
       where (s.repository, s.default_branch, s.project)
             is distinct from (excluded.repository, excluded.default_branch, excluded.project)`,
      [
        tx.businessId,
        site.partyId,
        site.repository.toLowerCase(),
        site.defaultBranch,
        site.project,
        actorId,
      ],
    );
    for (const page of site.pages) {
      // oxlint-disable-next-line no-await-in-loop -- one page after another, in one transaction
      await inner.query(
        `insert into public.party_site_pages (business_id, party_id, page_url, path)
         select $1, $2::uuid, $3, $4
          where not exists (select 1 from public.party_site_pages p
                             where p.business_id = $1 and p.party_id = $2::uuid
                               and p.page_url = $3 and p.path = $4)`,
        [tx.businessId, site.partyId, page.pageUrl, page.path],
      );
    }
  });
}

/**
 * Unbind one page of a client's site, unless an open correction names it. The
 * site row is taken before the page, the order every writer of the site keeps,
 * so two unbinds of one client's pages queue on it rather than deadlock.
 */
export async function unbindPartySitePage(
  tx: TransactionQuery,
  partyId: string,
  pageUrl: string,
): Promise<SiteWrite> {
  return await held(tx, async (inner) => {
    await inner.query(
      `select 1 from public.party_sites
        where business_id = $1 and party_id = $2::uuid
          for no key update`,
      [tx.businessId, partyId],
    );
    await inner.query(
      `delete from public.party_site_pages
        where business_id = $1 and party_id = $2::uuid and page_url = $3`,
      [tx.businessId, partyId, pageUrl],
    );
  });
}

/**
 * Whether the client's site still binds this page to this file. A plain read:
 * the caller holds the correction naming it, and while that correction is open
 * an unbind of the page waits for it and is refused, so the page stays.
 */
export async function isBoundPage(
  tx: TenantQuery,
  page: { readonly partyId: string; readonly pageUrl: string; readonly path: string },
): Promise<boolean> {
  const rows = await tx.query<{ readonly bound: boolean }>(
    `select true as bound from public.party_site_pages
      where business_id = $1 and party_id = $2::uuid and page_url = $3 and path = $4`,
    [tx.businessId, page.partyId, page.pageUrl, page.path],
  );
  return rows.length > 0;
}

/** The client's site with its pages, or undefined where the business binds none for it. */
export async function readPartySite(
  tx: TenantQuery,
  partyId: string,
): Promise<PartySiteRecord | undefined> {
  const [site] = await tx.query<{
    readonly repository: string;
    readonly default_branch: string;
    readonly project: string;
  }>(
    `select repository, default_branch, project from public.party_sites
      where business_id = $1 and party_id = $2::uuid`,
    [tx.businessId, partyId],
  );
  if (site === undefined) return undefined;
  const pages = await tx.query<{ readonly page_url: string; readonly path: string }>(
    `select page_url, path from public.party_site_pages
      where business_id = $1 and party_id = $2::uuid order by page_url`,
    [tx.businessId, partyId],
  );
  return {
    partyId,
    repository: site.repository,
    defaultBranch: site.default_branch,
    project: site.project,
    pages: pages.map((page) => ({ pageUrl: page.page_url, path: page.path })),
  };
}

/** Whether the task is a live task of the named party: asked only of the operand party. */
export async function isPartysTask(
  tx: TenantQuery,
  input: { readonly partyId: string; readonly taskId: string },
): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `select r.id from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $2::uuid and t.key = 'task' and r.uuid_7 = $3::uuid
        and r.deleted_at is null`,
    [tx.businessId, input.taskId, input.partyId],
  );
  return rows.length > 0;
}
