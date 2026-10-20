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
  // C35 (20261019123500): a review, its revisions and its asked captures are written, never
  // removed; a review moves only its count, and a capture (20261019142500) its claim and land,
  // by column.
  ['si', 'reviews'],
  ['si', 'review_revisions'],
  ['si', 'review_captures'],
  // U89 (20261020052900): a media asset is written when its upload starts, never removed.
  ['si', 'review_media_assets'],
  // C35 (20261019142500): a landed picture is written once and removed only through the
  // storage seam, never changed.
  ['sid', 'storage_objects'],
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
  // A claimed proposal is settled once, by these columns; its trigger refuses moving a settled one.
  {
    table: 'public.live_correction_proposals',
    from: '20261013110100',
    columns: ['head_commit', 'request_number', 'settled_at', 'state'],
  },
  { table: 'public.reviews', from: '20261019123500', columns: ['revision_count', 'updated_at'] },
  // A media upload moves only its state, and names its revision once completed.
  {
    table: 'public.review_media_assets',
    from: '20261020052900',
    columns: ['revision_id', 'state', 'updated_at'],
  },
  // The upload contract (#2039) admits a completed asset by these columns: refused, or
  // quarantined with its probe until a scan's verdict lands.
  {
    table: 'public.review_media_assets',
    from: '20261020053000',
    columns: [
      'probe_codec',
      'probe_duration',
      'probe_fps_den',
      'probe_fps_num',
      'probe_timecode',
      'probe_timescale',
      'refusal',
      'scan_engine',
      'scan_state',
      'scanned_at',
    ],
  },
  // A capture is claimed and landed by these columns; its trigger keeps its revision and width.
  {
    table: 'public.review_captures',
    from: '20261019142500',
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
] as const;
