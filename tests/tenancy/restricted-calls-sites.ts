// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's party-site part of the restricted-calls contract (20261013051839): a client's site and
// its pages, gathered with MP-14-10a's part in `restricted-calls-mandates.ts` and spread into the
// main lists beside the rest. Apart from them to keep each under the line limit.

/**
 * Table grants: a site is moved by column grant, never deleted; a page is bound and unbound; a
 * revert ask (20261013213000) is written once and never changed or removed.
 */
export const SITE_GROUPS: readonly (readonly [string, string])[] = [
  ['si', 'party_sites'],
  ['sid', 'party_site_pages'],
  ['si', 'live_correction_revert_asks'],
];

/** Executed: the freeze's one question; security invoker, so it reads no more than its caller may. */
export const SITE_EXECUTES: readonly string[] = ['public.party_site_under_correction'];

/**
 * Update: a site's providers move by column; a page's `path` only so a request can key-share
 * lock it, and its trigger refuses every update.
 */
export const SITE_UPDATES = [
  {
    table: 'public.party_sites',
    from: '20261013051839',
    columns: [
      'changed_at',
      'changed_by_actor_id',
      'default_branch',
      'project',
      'repository',
      'revision',
    ],
  },
  { table: 'public.party_site_pages', from: '20261013051839', columns: ['path'] },
] as const;
