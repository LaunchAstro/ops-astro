// SPDX-License-Identifier: AGPL-3.0-only
//
// C80's party-site part of the restricted-calls contract (20261013051839): a client's site and
// its pages, and a correction's proposal claimed before its first send (20261013110100), gathered with MP-14-10a's part in `restricted-calls-mandates.ts` and spread into the
// main lists beside the rest. Apart from them to keep each under the line limit.

/**
 * Table grants: a site is moved by column grant, never deleted; a page is bound and unbound; a
 * revert ask (20261014180943) is written once and never changed or removed.
 */
export const SITE_GROUPS: readonly (readonly [string, string])[] = [
  ['si', 'party_sites'],
  ['sid', 'party_site_pages'],
  ['si', 'live_correction_revert_asks'],
  // R5 (20261018050000): Astra's review of a correction, written once.
  ['si', 'live_correction_reviews'],
  ['si', 'live_correction_proposals'],
  // C35 (20261028140000): a review, its revisions and its asked captures are written, never
  // removed; a review moves only its count, and a capture (20261028142500) its claim and land,
  // by column.
  ['si', 'reviews'],
  ['si', 'review_revisions'],
  ['si', 'review_captures'],
  // U89 (20261114125600): a media asset is written when its upload starts, never removed.
  ['si', 'review_media_assets'],
  // C35 (20261028142500): a landed picture is written once and removed only through the
  // storage seam, never changed.
  ['sid', 'storage_objects'],
  // #2351 (20261101090000): a request to delete a task is written once and answered once by
  // column, never removed but by its task's purge (the key cascades).
  ['si', 'task_delete_requests'],
  // C35-X (20261114152700): a pin's carry onto a revision is written once and never changed.
  ['si', 'review_pin_carries'],
  // C57 (20261114162900): a change request is filed once and decided once, by column.
  ['si', 'review_change_requests'],
  // Docs (#2493, 20261115002300): a folder and a page move by column (20261115104000); a
  // version row is written once and never changed.
  ['si', 'docs_folders'],
  ['si', 'docs_pages'],
  ['si', 'docs_page_versions'],
  // C35 (#2018, 20261028190000): a closed capture pool review, installation-wide, written once
  // and never changed or removed; its column grants are in `SITE_GRANTS`.
  ['si', 'ops.capture_pool_reviews'],
];

/** Column grants: the application reads a pool review's identity and pool version alone. */
export const SITE_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  'pool_version',
  'review',
].map((column) => ({
  from: '20261028190000',
  line: `ops_astro_app SELECT ops.capture_pool_reviews.${column}`,
}));

/** Installation-wide tables under row security. C35 (#2018, 20261028190000). */
const SITE_ROW_SECURED: ReadonlySet<string> = new Set(['ops.capture_pool_reviews']);

/**
 * A granted call on an installation-wide table (0047's outbox, SL09's gate tables): a read sees
 * every row, and a write passes privilege and then meets the table's own constraints or
 * triggers, the permitted path. An insert into one under row security meets the policy first.
 */
export function installationWide(qualified: string, operation: string, own: number): string {
  if (operation === 'select') return `rows ${String(own)}`;
  return operation === 'insert' && SITE_ROW_SECURED.has(qualified) ? 'rls' : 'past privilege';
}

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
  // A claimed proposal is settled once, by these columns; its trigger refuses moving a settled one.
  {
    table: 'public.live_correction_proposals',
    from: '20261013110100',
    columns: ['head_commit', 'request_number', 'settled_at', 'state'],
  },
  { table: 'public.reviews', from: '20261028140000', columns: ['revision_count', 'updated_at'] },
  // A media upload moves only its state, and names its revision once completed.
  {
    table: 'public.review_media_assets',
    from: '20261114125600',
    columns: ['revision_id', 'state', 'updated_at'],
  },
  // A capture is claimed and landed by these columns; its trigger keeps its revision and width.
  {
    table: 'public.review_captures',
    from: '20261028142500',
    columns: [
      'fence',
      'landed_at',
      'lease_id',
      'observation',
      'picture_digest',
      'picture_id',
      'state',
      'updated_at',
    ],
  },
  {
    table: 'public.task_delete_requests',
    from: '20261101090000',
    columns: ['answer', 'answered_at', 'answered_by_actor_id'],
  },
  {
    table: 'public.review_change_requests',
    from: '20261114162900',
    columns: [
      'state',
      'decided_by_actor_id',
      'decided_by_person_id',
      'decided_at',
      'created_task_id',
      'updated_at',
    ],
  },
  {
    table: 'public.docs_pages',
    from: '20261115002300',
    columns: ['title', 'body', 'version', 'updated_by_actor_id', 'updated_at'],
  },
  // Docs piece 4a (#2514, 20261115104000): a folder is renamed or moved, and a page moved.
  { table: 'public.docs_folders', from: '20261115104000', columns: ['name', 'parent_id'] },
  { table: 'public.docs_pages', from: '20261115104000', columns: ['folder_id'] },
] as const;
