// SPDX-License-Identifier: AGPL-3.0-only
//
// The site runner's writes on the corrections it locates and checks (#1693).
// Only `apps/site-runner` reaches this file (`.dependency-cruiser.cjs`,
// `locate-writes-are-the-runners`): the pin and the stamp add facts the
// runner read through custody, and no other caller may vouch for a version.
//
// Every write names its lock. The pin and the stamp take the holder's site row
// first, then, in one statement, the correction's page (key share) and site
// (share), and require the binding to be the configured site the runner read
// under: the holder, its repository, default branch and project, and the
// configured page with its file. A pin that finds the binding changed settles
// `unlocated SITE_CHANGED`; a stamp that does not, writes nothing. Each time
// is `clock_timestamp()` in the statement, after its lock wait.
//
// The schedule: each correction handled in a pass is due again 15 s later, so
// it moves behind every one not yet handled; a provider failure backs off
// (30 s, 60 s, then 120 s at most), and a `locating` correction is never put
// off past 120 s after its request, when a failure settles it
// `unlocated SITE_UNREACHABLE`.

import type { TenantQuery } from '../tenancy/database.ts';

/** How many due corrections a pass takes: cheap rows, since the reads are shared. */
export const DUE_PER_PASS = 20;

const AGAIN = `clock_timestamp() + interval '15 seconds'`;
const LOCATE_FOR = `interval '120 seconds'`;

/** The one site the runner acts for (`SITE_RUNNER_SITE`), as the records compare it. */
export interface ConfiguredSite {
  /** The business itself, or the client the site belongs to. */
  readonly holder: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly project: string;
  readonly pages: readonly { readonly pageUrl: string; readonly path: string }[];
}

/** A correction due a check, with its holder's site as bound now (null: none). */
export interface DueCorrection {
  readonly id: string;
  readonly holder: string;
  readonly state: 'locating' | 'requested';
  readonly pageUrl: string;
  readonly targetPath: string;
  readonly word: string;
  readonly replacement: string;
  readonly seam: string;
  readonly preImageDigest: string | null;
  readonly site: {
    readonly repository: string;
    readonly defaultBranch: string;
    readonly project: string;
  } | null;
}

/** The due corrections of this business, in turn: never checked first, then oldest. */
export async function dueCorrections(
  tx: TenantQuery,
  limit: number = DUE_PER_PASS,
): Promise<readonly DueCorrection[]> {
  const rows = await tx.query<{
    readonly id: string;
    readonly holder: string;
    readonly state: 'locating' | 'requested';
    readonly page_url: string;
    readonly target_path: string;
    readonly word: string;
    readonly replacement: string;
    readonly seam: string;
    readonly pre_image_digest: string | null;
    readonly repository: string | null;
    readonly default_branch: string | null;
    readonly project: string | null;
  }>(
    `select c.id, coalesce(c.party_id, c.business_id) as holder, c.state, c.page_url,
            c.target_path, c.word, c.replacement, c.seam, c.pre_image_digest,
            s.repository, s.default_branch, s.project
       from public.live_corrections c
       left join public.party_sites s
         on s.business_id = c.business_id and s.holder = coalesce(c.party_id, c.business_id)
      where c.business_id = $1 and c.state in ('locating', 'requested')
        and (c.next_check_at is null or c.next_check_at <= clock_timestamp())
      order by c.next_check_at nulls first, c.created_at, c.id
      limit $2`,
    [tx.businessId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    holder: row.holder,
    state: row.state,
    pageUrl: row.page_url,
    targetPath: row.target_path,
    word: row.word,
    replacement: row.replacement,
    seam: row.seam,
    preImageDigest: row.pre_image_digest,
    site:
      row.repository === null || row.default_branch === null || row.project === null
        ? null
        : { repository: row.repository, defaultBranch: row.default_branch, project: row.project },
  }));
}

/** The holder's site row, share-locked on its own: the order every writer of the site keeps. */
async function shareHoldersSite(tx: TenantQuery, id: string): Promise<void> {
  await tx.query(
    `select 1 from public.party_sites s
      where s.business_id = $1
        and s.holder = (select coalesce(c.party_id, c.business_id) from public.live_corrections c
                         where c.business_id = $1 and c.id = $2)
        for share`,
    [tx.businessId, id],
  );
}

/**
 * The correction's binding is the configured site's, page and file included: page key-share
 * and site share locked, in the statement that writes. `$2` is the correction, `$3` to `$8` the
 * configured site.
 */
const BOUND = `select 1 from public.party_site_pages p
    join public.party_sites s on s.business_id = p.business_id and s.holder = p.holder
   where p.business_id = c.business_id and p.holder = coalesce(c.party_id, c.business_id)
     and p.page_url = c.page_url and p.path = c.target_path
     and s.holder = $3::uuid and s.repository = lower($4) and s.default_branch = $5
     and s.project = $6
     and (c.page_url, c.target_path) in (select * from unnest($7::text[], $8::text[]))
     for key share of p for share of s`;

const siteParameters = (site: ConfiguredSite) => [
  site.holder,
  site.repository,
  site.defaultBranch,
  site.project,
  site.pages.map((page) => page.pageUrl),
  site.pages.map((page) => page.path),
];

export interface LocatedPin {
  readonly id: string;
  readonly versionId: string;
  readonly baseRevision: string;
  readonly preImageDigest: string;
  readonly versionDigest: string;
}

/**
 * Pin a `locating` correction from the file the runner read at `baseRevision`, stamped as checked
 * now. The binding changed under it: `unlocated SITE_CHANGED`. No longer locating: `gone`.
 */
export async function pinLocated(
  tx: TenantQuery,
  site: ConfiguredSite,
  pin: LocatedPin,
): Promise<'pinned' | 'unlocated' | 'gone'> {
  await shareHoldersSite(tx, pin.id);
  const pinned = await tx.query<{ readonly id: string }>(
    `update public.live_corrections as c
        set pre_image_digest = $9, base_revision = $10, version_id = $11::uuid,
            version_digest = $12, located_at = clock_timestamp(), verified_at = clock_timestamp(),
            next_check_at = ${AGAIN}, check_failures = 0, state = 'requested',
            revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'locating' and exists (${BOUND})
      returning c.id`,
    [
      tx.businessId,
      pin.id,
      ...siteParameters(site),
      pin.preImageDigest,
      pin.baseRevision,
      pin.versionId,
      pin.versionDigest,
    ],
  );
  if (pinned.length > 0) return 'pinned';
  return (await unlocate(tx, pin.id, 'SITE_CHANGED')) ? 'unlocated' : 'gone';
}

/** Settle a `locating` correction `unlocated` with its fixed code; false when it is not locating. */
export async function unlocate(tx: TenantQuery, id: string, code: string): Promise<boolean> {
  const rows = await tx.query<{ readonly id: string }>(
    `update public.live_corrections as c
        set state = 'unlocated', locate_code = $3, located_at = clock_timestamp(),
            revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'locating'
      returning c.id`,
    [tx.businessId, id, code],
  );
  return rows.length > 0;
}

/**
 * Stamp a `requested` correction checked now: the default branch's file still holds its pinned
 * bytes (`digest`), and its binding is still the configured site's. False: nothing written.
 */
export async function stampVerified(
  tx: TenantQuery,
  site: ConfiguredSite,
  id: string,
  digest: string,
): Promise<boolean> {
  await shareHoldersSite(tx, id);
  const rows = await tx.query<{ readonly id: string }>(
    `update public.live_corrections as c
        set verified_at = clock_timestamp(), next_check_at = ${AGAIN}, check_failures = 0
      where c.business_id = $1 and c.id = $2 and c.state = 'requested'
        and c.pre_image_digest = $9 and exists (${BOUND})
      returning c.id`,
    [tx.businessId, id, ...siteParameters(site), digest],
  );
  return rows.length > 0;
}

/**
 * A `requested` correction whose file no longer holds its pinned bytes, and whose binding is still
 * the configured site's: `superseded`. False: nothing written.
 */
export async function supersede(
  tx: TenantQuery,
  site: ConfiguredSite,
  id: string,
  digest: string,
): Promise<boolean> {
  await shareHoldersSite(tx, id);
  const rows = await tx.query<{ readonly id: string }>(
    `update public.live_corrections as c
        set state = 'superseded', locate_code = 'CONTENT_DRIFTED',
            revision = c.revision + 1, updated_at = now()
      where c.business_id = $1 and c.id = $2 and c.state = 'requested'
        and c.pre_image_digest is distinct from $9 and exists (${BOUND})
      returning c.id`,
    [tx.businessId, id, ...siteParameters(site), digest],
  );
  return rows.length > 0;
}

/** Corrections handled in a pass with nothing written: due again after every other. */
export async function checkLater(tx: TenantQuery, ids: readonly string[]): Promise<void> {
  await tx.query(
    `update public.live_corrections as c set next_check_at = ${AGAIN}
      where c.business_id = $1 and c.id = any($2::uuid[]) and c.state in ('locating', 'requested')`,
    [tx.businessId, ids],
  );
}

/**
 * The provider failed for these corrections' path: each backs off, and a `locating` one past
 * 120 s since its request settles `unlocated SITE_UNREACHABLE`. Answers the ids it settled.
 */
export async function checksFailed(
  tx: TenantQuery,
  ids: readonly string[],
): Promise<readonly string[]> {
  const aged = `(c.state = 'locating' and c.created_at <= clock_timestamp() - ${LOCATE_FOR})`;
  const rows = await tx.query<{ readonly id: string; readonly state: string }>(
    `update public.live_corrections as c
        set state = case when ${aged} then 'unlocated' else c.state end,
            locate_code = case when ${aged} then 'SITE_UNREACHABLE' else c.locate_code end,
            located_at = case when ${aged} then clock_timestamp() else c.located_at end,
            revision = case when ${aged} then c.revision + 1 else c.revision end,
            check_failures = case when ${aged} then c.check_failures else c.check_failures + 1 end,
            next_check_at = case when ${aged} then c.next_check_at else least(
              clock_timestamp() + least(interval '15 seconds' * power(2, c.check_failures + 1),
                                        interval '120 seconds'),
              case when c.state = 'locating' then c.created_at + ${LOCATE_FOR} end) end
      where c.business_id = $1 and c.id = any($2::uuid[]) and c.state in ('locating', 'requested')
      returning c.id, c.state`,
    [tx.businessId, ids],
  );
  return rows.filter((row) => row.state === 'unlocated').map((row) => row.id);
}
