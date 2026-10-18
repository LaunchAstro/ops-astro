// SPDX-License-Identifier: AGPL-3.0-only
//
// The one site the runner acts for (`SITE_RUNNER_SITE`, #1693): its holder,
// repository, default branch, hosting project and pages, each page with its
// source file. Every provider call is checked against it before anything else
// (`admitting`, the guarded call's `admit`), so a correction bound to any other
// site, or a page and file it does not hold, sends nothing whatever the
// token's scope would allow. A refusal is `SITE_NOT_CONFIGURED`.

import type { CallDependencies } from '../../packages/core-connectors/src/index.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';
import type { ConfiguredSite } from '../../packages/core-records/src/site/locate.ts';

export type { ConfiguredSite };

export const NOT_CONFIGURED = 'SITE_NOT_CONFIGURED';

/** A site binding as the records hold it: its providers, or none. */
export interface BoundSite {
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
}

/** The binding is the configured site's own: the holder and its providers, the repository in any case. */
export function bindingConfigured(
  site: ConfiguredSite,
  holder: string,
  bound: BoundSite | null | undefined,
): boolean {
  return (
    bound !== null &&
    bound !== undefined &&
    holder === site.holder &&
    bound.repository.toLowerCase() === site.repository.toLowerCase() &&
    bound.defaultBranch === site.defaultBranch &&
    bound.project === site.project
  );
}

/** The page and its file are one configured pair, byte for byte. */
export const pairConfigured = (site: ConfiguredSite, pageUrl: string, path: string): boolean =>
  site.pages.some((page) => page.pageUrl === pageUrl && page.path === path);

/** Operations that act on the default branch by name, and the one that opens a request onto it. */
const ON_DEFAULT_BRANCH = new Set(['site.source.head', 'site.publish', 'site.source.revert']);
const ONTO_DEFAULT_BRANCH = 'site.source.propose.request';

/**
 * The guarded call's admission for ports built on the configured site: for one page (a correction's
 * proposal or publish), or for every configured page when `page` is left out (the locate). A page
 * the site does not hold admits nothing.
 */
export function admitting(
  site: ConfiguredSite,
  page?: { readonly pageUrl?: string; readonly path: string },
): NonNullable<CallDependencies['admit']> {
  const pages = site.pages.filter(
    (held) =>
      page === undefined ||
      (held.path === page.path && (page.pageUrl === undefined || held.pageUrl === page.pageUrl)),
  );
  const paths = new Set(pages.map((held) => held.path));
  const hosts = new Set(pages.map((held) => new URL(held.pageUrl).host));
  const fits = (operation: string, name: string, value: string): boolean => {
    switch (name) {
      case 'repository':
        return value.toLowerCase() === site.repository.toLowerCase();
      case 'path':
        return paths.has(value);
      case 'project':
        return value === site.project;
      case 'host':
        return hosts.has(value);
      case 'branch':
        return !ON_DEFAULT_BRANCH.has(operation) || value === site.defaultBranch;
      case 'base':
        return operation !== ONTO_DEFAULT_BRANCH || value === site.defaultBranch;
      default:
        return true;
    }
  };
  return (operation, params) => {
    if (pages.length === 0) return NOT_CONFIGURED;
    const admitted = Object.entries(params).every(([name, value]) => fits(operation, name, value));
    return admitted ? undefined : NOT_CONFIGURED;
  };
}

/**
 * The holder is the business itself, or a client of it: one read of `public.clients` at start-up.
 * A holder outside the business answers the key, never its value.
 */
export async function holderRefuses(
  tx: TenantQuery,
  site: ConfiguredSite,
): Promise<string | undefined> {
  if (site.holder === tx.businessId) return undefined;
  const rows = await tx.query<{ readonly id: string }>(
    `select id from public.clients where business_id = $1 and id = $2::uuid`,
    [tx.businessId, site.holder],
  );
  return rows.length === 1
    ? undefined
    : 'SITE_RUNNER_SITE.holder is not the business or its client';
}
