// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-14-10a's column grants, held against `restricted-calls-catalogue.ts`'s
// contract beside the rest. Apart from it to keep that file under the line limit.

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
};

/** The insert grants above as role column grants: a mandate is filed with its own columns. */
export const MANDATE_GRANTS: readonly { readonly from: string; readonly line: string }[] = (
  INSERT_COLUMNS['public.standing_mandates'] ?? []
).map((column) => ({
  from: '20261006080000',
  line: `ops_astro_app INSERT public.standing_mandates.${column}`,
}));
