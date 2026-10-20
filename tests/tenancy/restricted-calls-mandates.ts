// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a's part of the restricted-calls contract (20261006080000): its table grants, column
// grants and the one function the application executes, spread into `restricted-calls-cases.ts`
// and `restricted-calls-catalogue.ts` beside the rest. Apart from them to keep both under the
// line limit. `PART_GROUPS` and `PART_UPDATES` gather it with #1531's part.

import {
  CARRIAGE_EXECUTES,
  CARRIAGE_GROUPS,
  CARRIAGE_UPDATES,
} from './restricted-calls-carriage.ts';
import { SITE_EXECUTES, SITE_GROUPS, SITE_UPDATES } from './restricted-calls-sites.ts';
import { TRACE_GRANTS } from './restricted-calls-trace.ts';

/**
 * Table grants: a class's record is read and its revision bumped by column grant; a mandate is
 * filed by its own columns and revoked by column grant, never edited.
 */
export const MANDATE_GROUPS: readonly (readonly [string, string])[] = [
  ['s', 'graduation_classes'],
  ['si', 'standing_mandates'],
  // 20261012123000 (#1427): a draft is bound to the mandate it filed, once.
  ['si', 'standing_mandate_drafts'],
];

/** Executed: a mandate's word list checked whole, in its check constraint. */
export const MANDATE_EXECUTES: readonly string[] = [
  'public.standing_mandate_words_known',
  // 20261012123000 (#1427): a filing's identity, judged by the command and by the insert trigger.
  'public.standing_mandate_live_filing',
];

/**
 * Update: promoting and demoting serialise on a class's revision; a mandate is revoked,
 * never edited.
 */
export const MANDATE_UPDATES = [
  { table: 'public.graduation_classes', from: '20261006080000', columns: ['revision'] },
  {
    table: 'public.standing_mandates',
    from: '20261006080000',
    columns: ['revision', 'revoked_at', 'revoked_by_actor_id'],
  },
] as const;

/**
 * Insert granted column by column. A mandate's `created_at` is the database's, and it is
 * filed live, at revision 1.
 */
export const INSERT_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  'public.standing_mandates': [
    ...'authored_by_actor_id business_id ceiling_minor classes client_id currency'.split(' '),
    ...'expires_at graduation_class id label refuses'.split(' '),
  ],
  'public.standing_mandate_drafts': ['business_id', 'client_id', 'draft_id', 'mandate_id'],
};

/** The insert grants above as role column grants: a mandate is filed with its own columns. */
export const MANDATE_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  ...(INSERT_COLUMNS['public.standing_mandates'] ?? []).map((column) => ({
    from: '20261006080000',
    line: `ops_astro_app INSERT public.standing_mandates.${column}`,
  })),
  ...(INSERT_COLUMNS['public.standing_mandate_drafts'] ?? []).map((column) => ({
    from: '20261012123000',
    line: `ops_astro_app INSERT public.standing_mandate_drafts.${column}`,
  })),
];

/** Every part's role column grants: the mandates' and the trace export's (#1708). */
export const PART_GRANTS: readonly { readonly from: string; readonly line: string }[] = [
  ...MANDATE_GRANTS,
  ...TRACE_GRANTS,
];

/**
 * This part, #1531's (`restricted-calls-carriage.ts`) and C80's party sites
 * (`restricted-calls-sites.ts`), as the main lists spread them.
 */
export const PART_GROUPS: readonly (readonly [string, string])[] = [
  ...MANDATE_GROUPS,
  ...CARRIAGE_GROUPS,
  ...SITE_GROUPS,
];
export const PART_EXECUTES: readonly string[] = [
  ...MANDATE_EXECUTES,
  ...CARRIAGE_EXECUTES,
  ...SITE_EXECUTES,
];
export const PART_UPDATES: readonly {
  readonly table: string;
  readonly from: string;
  readonly columns: readonly string[];
}[] = [...MANDATE_UPDATES, ...CARRIAGE_UPDATES, ...SITE_UPDATES];
