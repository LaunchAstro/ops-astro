// SPDX-License-Identifier: AGPL-3.0-only
//
// Each client's site (C80), and the business's own (R6, #1688): its
// repository, default branch and hosting project, and each page with its
// source file. The one place a site's holder is mapped to its pages, read by a
// correction's request in its insert and by the runner for its binding. A
// site's holder is its client, or the business itself where its party is null:
// no client is the business, so the two never meet. No command writes it: the operator's own script
// binds a site, under the business's tenancy, as an actor of that business.
//
// A site is bound once in the installation (its repository, in lower case,
// and its project id are unique across businesses), and a page names one
// client in its business. While a correction of the client is open, no page of
// its site is unbound and its providers do not change (the storage refuses,
// with the corrections share-locked so one being written is waited for).

import type { Subject } from '../authority/grants.ts';
import type { TenantQuery } from '../tenancy/database.ts';
import type { TransactionQuery } from '../tenancy/transaction.ts';
import { COVERED, EFFECTIVE_AT, coveringParameters, holdCoveringGrants } from './covering.ts';

/** One site as the runner binds it: the shape `core-connectors` takes. */
export interface PartySiteRecord {
  /** The client the site belongs to, or null for the business's own site. */
  readonly partyId: string | null;
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
       on conflict (business_id, holder) do update
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
                             where p.business_id = $1 and p.holder = coalesce($2::uuid, $1)
                               and p.page_url = $3 and p.path = $4)`,
        [tx.businessId, site.partyId, page.pageUrl, page.path],
      );
    }
  });
}

/**
 * Unbind one page of a site (null: the business's own), unless an open correction names it. The
 * site row is taken before the page, the order every writer of the site keeps,
 * so two unbinds of one client's pages queue on it rather than deadlock.
 */
export async function unbindPartySitePage(
  tx: TransactionQuery,
  partyId: string | null,
  pageUrl: string,
): Promise<SiteWrite> {
  return await held(tx, async (inner) => {
    await inner.query(
      `select 1 from public.party_sites
        where business_id = $1 and holder = coalesce($2::uuid, $1)
          for no key update`,
      [tx.businessId, partyId],
    );
    await inner.query(
      `delete from public.party_site_pages
        where business_id = $1 and holder = coalesce($2::uuid, $1) and page_url = $3`,
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
  page: { readonly partyId: string | null; readonly pageUrl: string; readonly path: string },
): Promise<boolean> {
  const rows = await tx.query<{ readonly bound: boolean }>(
    `select true as bound from public.party_site_pages
      where business_id = $1 and holder = coalesce($2::uuid, $1) and page_url = $3
        and path = $4`,
    [tx.businessId, page.partyId, page.pageUrl, page.path],
  );
  return rows.length > 0;
}

/**
 * The client's site with its pages (null: the business's own), or undefined
 * where the business binds none for it.
 */
export async function readPartySite(
  tx: TenantQuery,
  partyId: string | null,
): Promise<PartySiteRecord | undefined> {
  const [site] = await tx.query<{
    readonly repository: string;
    readonly default_branch: string;
    readonly project: string;
  }>(
    `select repository, default_branch, project from public.party_sites
      where business_id = $1 and holder = coalesce($2::uuid, $1)`,
    [tx.businessId, partyId],
  );
  if (site === undefined) return undefined;
  const pages = await tx.query<{ readonly page_url: string; readonly path: string }>(
    `select page_url, path from public.party_site_pages
      where business_id = $1 and holder = coalesce($2::uuid, $1) order by page_url`,
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

/**
 * The site row (null: the business's own), share-locked on its own before a
 * request locks its page: an unbind takes the site before the page, so a
 * request does too.
 */
export async function shareClientSite(tx: TenantQuery, partyId: string | null): Promise<void> {
  await tx.query(
    `select 1 from public.party_sites
      where business_id = $1 and holder = coalesce($2::uuid, $1)
        for share`,
    [tx.businessId, partyId],
  );
}

/**
 * The client of a live task (null: a task with no client, whose site is the business's own), or
 * undefined where the id names no live task in this business. A plain read: the request reads
 * the task again, share-locked, in its insert.
 */
export async function taskClient(
  tx: TenantQuery,
  taskId: string,
): Promise<string | null | undefined> {
  const rows = await tx.query<{ readonly party: string | null }>(
    `select r.uuid_7 as party from public.records r
       join public.record_types t on t.business_id = r.business_id and t.id = r.record_type_id
      where r.business_id = $1 and r.id = $2::uuid and t.key = 'task' and r.deleted_at is null`,
    [tx.businessId, taskId],
  );
  return rows[0] === undefined ? undefined : rows[0].party;
}

/**
 * The business's own bound pages the caller may ask a correction on (#1988):
 * those its `run:write` reaches, judged in the query as every covered read
 * is, each with its site's repository, in address order, at most `limit`.
 * Only the business's own site: a client's pages are never listed, as a chat
 * on a client's task asks no model (owner line 72). The path is not read.
 */
export async function coveredOwnSitePages(
  tx: TenantQuery,
  subjects: readonly Subject[],
  limit: number,
): Promise<readonly { readonly repository: string; readonly page: string }[]> {
  return await tx.query<{ readonly repository: string; readonly page: string }>(
    `${EFFECTIVE_AT}
     select s.repository, c.page_url as page
       from public.party_site_pages c
       join public.party_sites s on s.business_id = c.business_id and s.holder = c.holder
      where c.business_id = $1 and c.party_id is null and s.party_id is null and ${COVERED}
      order by c.page_url
      limit $6`,
    [tx.businessId, ...coveringParameters({ subjects, collection: 'run', action: 'write' }), limit],
  );
}

/**
 * Whether the caller's `run:write` still reaches every one of these own pages,
 * judged as `coveredOwnSitePages` lists them: the grants held for share first,
 * so a revocation commits before the read, which sees it, or waits for the
 * caller to commit. A plan call's listed pages are asked here under the
 * broker's locks before anything is sent (S2100-1). None listed, yes.
 */
export async function coversOwnSitePages(
  tx: TenantQuery,
  subjects: readonly Subject[],
  sites: readonly { readonly repository: string; readonly page: string }[],
): Promise<boolean> {
  if (sites.length === 0) return true;
  const covering = { subjects, collection: 'run', action: 'write' };
  await holdCoveringGrants(tx, covering);
  const [row] = await tx.query<{ readonly covered: number }>(
    `${EFFECTIVE_AT}
     select count(*)::int as covered
       from public.party_site_pages c
       join public.party_sites s on s.business_id = c.business_id and s.holder = c.holder
       join unnest($6::text[], $7::text[]) as asked (repository, page)
         on asked.repository = s.repository and asked.page = c.page_url
      where c.business_id = $1 and c.party_id is null and s.party_id is null and ${COVERED}`,
    [
      tx.businessId,
      ...coveringParameters(covering),
      sites.map((site) => site.repository),
      sites.map((site) => site.page),
    ],
  );
  return row?.covered === sites.length;
}
